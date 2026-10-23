import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { boot, call, routeOf } from './helpers/host-harness.mjs'
import { ROUTE_PREFIX } from '../lib/routes.js'


test('apply 把全部端点注册进官方 /api 精确路由表', async () => {
  const env = await boot()
  try {
    assert.equal(env.registryReady, true)
    assert.equal(env.routes.length, 8, `端点条数不对：${env.routes.map((r) => r.path).join('、')}`)
    const readPaths = ['/catalog', '/registry', '/skill/content'].map((suffix) => `${ROUTE_PREFIX}${suffix}`)
    for (const route of env.routes) {
      assert.ok(route.path.startsWith(`${ROUTE_PREFIX}/`), `${route.path} 不在 ${ROUTE_PREFIX} 下`)
      // 只声明自己真正用的方法：读端点 GET，写端点 POST。写宽了会让错方法的请求走进业务逻辑。
      assert.deepEqual([...route.methods], [readPaths.includes(route.path) ? 'GET' : 'POST'], `${route.path} 的方法声明不对`)
      assert.equal(route.requestBody, 'buffered', `${route.path} 必须走可判长度的缓冲体`)
      assert.equal(typeof route.fetch, 'function', `${route.path} 缺少 fetch`)
    }
    // 0.3.0 的破坏性改动：不再自己往 webServer 上挂前缀路由（那要求 webRuntime，而
    // DSH 0.2.x 删了它）。这条断言就是那次事故的守卫。
    assert.equal(env.rawRoutes.length, 0, '不应该再有直注册到 webServer 的路由')
    assert.ok(env.tools.length >= 6, `工具数量偏少：${env.tools.length}`)
    assert.ok(env.tools.some((t) => t.name === 'skills_set_enabled'))
  } finally {
    env.cleanup()
  }
})

test('每个工具都声明了 ctx.tools.register 要求的完整 output', async () => {
  const env = await boot()
  try {
    // 这条断言来自一次真机事故：漏掉 output.render 会让 register 在挂载期抛错，
    // 而挂载期的抛错会把整个 DSH profile 的插件树加载打断 —— DSH 直接起不来。
    for (const tool of env.tools) {
      assert.ok(tool.output, `${tool.name} 缺少 output`)
      assert.ok(tool.output.schema, `${tool.name} 缺少 output.schema`)
      assert.equal(typeof tool.output.render, 'function', `${tool.name} 缺少 output.render`)
      assert.ok(tool.parameters && tool.parameters.type === 'object', `${tool.name} 的 parameters 必须是 object schema`)
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, `${tool.name} 的描述太短，模型无法据它选择工具`)
      assert.equal(typeof tool.execute, 'function')
    }
  } finally {
    env.cleanup()
  }
})

test('工具渲染把失败结果显示成可读文本', async () => {
  const env = await boot()
  try {
    const tool = env.tools.find((t) => t.name === 'skills_get')
    const rendered = tool.output.render({}, { ok: false, error: '找不到名为 x 的技能' })
    assert.ok(Array.isArray(rendered))
    assert.match(rendered[0].text, /找不到名为 x 的技能/)
  } finally {
    env.cleanup()
  }
})

test('依赖晚于插件就绪时，端点会等它出现再注册', async () => {
  // 这就是真机上真实发生过的时序：cordis 只等声明过的服务，插件先挂载，webServer 后到。
  // 曾经的做法是当场 `ctx.get('webServer')` 拿到 undefined 就静默放弃 —— 服务端一切正常，
  // 日志一片干净，只是每个请求都 404。0.2.0 起又多了一层：就绪条件里写了一个已经不存在的
  // 服务名（webRuntime），闸门同样永远打不开。
  const env = await boot({ deferWebServer: true, deferConnection: true, deferTools: true })
  try {
    assert.equal(env.routes.length, 0, '服务未就绪时不该注册')
    assert.equal(env.pending.length, 2, '应当挂起两处延迟注入等待服务')
    env.provide(['webServer', 'tools'])
    assert.equal(env.routes.length, 0, '只有 webServer、没有 connection 时不该注册')
    assert.equal(env.tools.length, 7, 'tools 出现后工具必须补上')
    env.provide(['connection'])
    assert.equal(env.routes.length, 8, 'connection 出现后端点必须补上')
    const response = await env.request('GET', '/api/dsh-skills-manager/catalog')
    assert.equal(response.ok, true)
  } finally {
    env.cleanup()
  }
})

test('GET /registry 没有 agent 时退回宿主层视图', async () => {
  const env = await boot()
  try {
    const response = await env.request('GET', '/api/dsh-skills-manager/registry')
    assert.equal(response.ok, true)
    assert.equal(response.data.scope, 'host')
    assert.deepEqual(response.data.agents, [])
    assert.ok(response.data.skills.length > 0, '宿主层在测试环境里由文件系统提供方供数')
    assert.ok(response.data.host.skills.length > 0)
  } finally {
    env.cleanup()
  }
})

test('GET /registry 有 agent 时，把该 agent 的作用域 key 传给注册表', async () => {
  // 两条容易致命的细节在这里被钉住：
  //  1. `snapshot()` 只按 `options.scope` 选层，不从调用上下文推断 —— 所以必须显式传，
  //     否则读到的是 global 层（真实部署里那是空的，表现为「界面正常、查询为空」）。
  //  2. 作用域符号是上游模块私有的（`Symbol("dsh.scope")`），本插件按符号描述去找它，
  //     跨模块实例也不会失效。这里用一个自造的同类符号验证这条查找路径。
  const scopeKey = { opaque: 'agent-1' }
  const agentCtx = { get: () => undefined }
  agentCtx[Symbol('dsh.scope')] = scopeKey

  // 新契约不借用未知项目的 agent；该夹具明确归属请求默认 cwd。
  const env = await boot({ agents: { list: () => [{ id: 'agent-1', ctx: agentCtx, session: { header: { cwd: process.cwd() } } }] } })
  try {
    const seen = []
    const original = env.registry.snapshot.bind(env.registry)
    env.registry.snapshot = async (options) => {
      seen.push(options)
      return original(options)
    }
    const response = await env.request('GET', '/api/dsh-skills-manager/registry')
    assert.equal(response.data.scope, 'agent')
    assert.ok(
      seen.some((options) => options?.scope === scopeKey),
      `路由必须把 agent 的作用域 key 传给 snapshot，实际收到：${JSON.stringify(seen.map((o) => typeof o?.scope))}`,
    )
    assert.equal(response.data.agents[0].id, 'agent-1')
    assert.ok(Array.isArray(response.data.skills))
  } finally {
    env.cleanup()
  }
})

test('agent 上下文没有作用域标记时如实报告，而不是退回 global 的空结果', async () => {
  const agentCtx = { get: () => ({ async snapshot() { return { complete: true, skills: [] } } }) }
  const env = await boot({ agents: { list: () => [{ id: 'agent-x', ctx: agentCtx }] } })
  try {
    const response = await env.request('GET', '/api/dsh-skills-manager/registry')
    assert.equal(response.data.agents[0].count, null)
    assert.match(response.data.agents[0].reason, /作用域标识/)
  } finally {
    env.cleanup()
  }
})

test('GET /catalog 返回根与技能视图', async () => {
  const env = await boot()
  try {
    const response = await env.request('GET', '/api/dsh-skills-manager/catalog')
    assert.equal(response.statusCode, 200)
    assert.equal(response.ok, true)
    const names = response.data.skills.map((s) => s.name)
    assert.ok(names.includes('plain'))
    assert.ok(names.includes('locked'))
    const plain = response.data.skills.find((s) => s.name === 'plain')
    assert.equal(plain.winner, true)
    assert.equal(plain.effectiveModelInvocable, true)
    assert.ok(response.data.roots.some((r) => r.key === 'dsh'))
  } finally {
    env.cleanup()
  }
})

test('POST /policy 停用后，注册表的真实裁决随之改变', async () => {
  const env = await boot()
  try {
    const before = await env.request('GET', '/api/dsh-skills-manager/registry')
    assert.equal(before.data.skills.find((s) => s.name === 'plain').modelInvocable, true)

    const response = await env.request('POST', '/api/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'plain', enabled: false })
    assert.equal(response.ok, true, response.error)

    const after = await env.request('GET', '/api/dsh-skills-manager/registry')
    const plain = after.data.skills.find((s) => s.name === 'plain')
    assert.equal(plain.modelInvocable, false, '注册表必须真的不再向模型提供它')
    assert.equal(plain.userInvocable, false)
    assert.equal(plain.fromThisPlugin, true, '胜出的应当是本插件的覆盖候选')

    assert.equal(
      readFileSync(join(env.home, 'skills', 'plain', 'SKILL.md'), 'utf8').includes('disable-model-invocation'),
      false,
      '源文件必须一个字节都没被改动',
    )
  } finally {
    env.cleanup()
  }
})

test('POST /policy 能翻转文件里的 disable-model-invocation', async () => {
  const env = await boot()
  try {
    const response = await env.request('POST', '/api/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'locked', enabled: true })
    assert.equal(response.ok, true, response.error)
    const registry = await env.request('GET', '/api/dsh-skills-manager/registry')
    assert.equal(registry.data.skills.find((s) => s.name === 'locked').modelInvocable, true)
    assert.ok(readFileSync(join(env.home, 'skills', 'locked', 'SKILL.md'), 'utf8').includes('disable-model-invocation'), '文件里那句仍然在')
  } finally {
    env.cleanup()
  }
})

test('POST /skill/create 落盘，重复创建被拒', async () => {
  const env = await boot()
  try {
    const created = await env.request('POST', '/api/dsh-skills-manager/skill/create', {
      rootKey: 'dsh',
      name: 'Brand New',
      description: '新建的技能',
      body: '正文',
    })
    assert.equal(created.ok, true, created.error)
    assert.equal(created.name, 'brand-new')
    assert.equal(existsSync(join(env.home, 'skills', 'brand-new', 'SKILL.md')), true)
    assert.ok(created.catalog.skills.some((s) => s.name === 'brand-new'))

    const again = await env.request('POST', '/api/dsh-skills-manager/skill/create', { rootKey: 'dsh', name: 'brand-new', description: 'x' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'skill.exists')
  } finally {
    env.cleanup()
  }
})

test('POST /skill/save 拒绝会弄坏技能的正文', async () => {
  const env = await boot()
  try {
    const broken = await env.request('POST', '/api/dsh-skills-manager/skill/save', {
      rootKey: 'dsh',
      name: 'plain',
      content: '彻底没有 frontmatter',
    })
    assert.equal(broken.ok, false)
    assert.equal(broken.code, 'document.invalid')
    assert.match(readFileSync(join(env.home, 'skills', 'plain', 'SKILL.md'), 'utf8'), /普通技能/)

    const saved = await env.request('POST', '/api/dsh-skills-manager/skill/save', {
      rootKey: 'dsh',
      name: 'plain',
      content: '---\nname: plain\ndescription: 改过了\n---\n新正文\n',
    })
    assert.equal(saved.ok, true, saved.error)
    assert.match(readFileSync(join(env.home, 'skills', 'plain', 'SKILL.md'), 'utf8'), /新正文/)
  } finally {
    env.cleanup()
  }
})

test('删除端点：文件真的从磁盘上没了', async () => {
  const env = await boot()
  try {
    const deleted = await env.request('POST', '/api/dsh-skills-manager/skill/delete', { rootKey: 'dsh', name: 'plain' })
    assert.equal(deleted.ok, true, deleted.error)
    assert.equal(existsSync(join(env.home, 'skills', 'plain')), false, 'bundle 的整个目录都要没了')
    assert.equal(deleted.catalog.skills.some((s) => s.name === 'plain'), false, '目录里也不该再有它')
  } finally {
    env.cleanup()
  }
})

test('删除技能会一并清掉它的启停覆盖', async () => {
  const env = await boot()
  try {
    await env.request('POST', '/api/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'plain', enabled: false })
    await env.request('POST', '/api/dsh-skills-manager/skill/delete', { rootKey: 'dsh', name: 'plain' })
    const state = JSON.parse(readFileSync(join(env.home, 'dsh-skills-manager', 'state.json'), 'utf8'))
    assert.deepEqual(state.overrides.dsh ?? {}, {}, '同名技能以后重建时不该继承旧的停用状态')
  } finally {
    env.cleanup()
  }
})

test('未知 rootKey 被拒绝，且 handler 不再自行判 Host', async () => {
  const env = await boot()
  try {
    const unknown = await env.request('POST', '/api/dsh-skills-manager/policy', { rootKey: 'nope', name: 'plain', enabled: false })
    assert.equal(unknown.code, 'root.unknown')

    // Host 校验已经**移交给宿主**：端点注册在官方 `/api` 通道，宿主在我们之前跑完
    // Host/Origin fence 与浏览器会话鉴权，未通过的请求到不了 handler。所以这里带一个
    // 可疑的 Host 也照样能跑通 —— 这正是「访问控制不是本文件的职责」的机器可读表达。
    const foreign = await env.request('GET', '/api/dsh-skills-manager/catalog', undefined, 'evil.example.com')
    assert.equal(foreign.ok, true, 'Host 不再是本插件的判定项；应由宿主的 fence 拦下')
  } finally {
    env.cleanup()
  }
})

test('访问控制交给宿主：不直注册 webServer，也没留下自己的 Host 判定', async () => {
  const env = await boot()
  try {
    // 两条一起表达同一个契约：唯一的暴露面是官方 /api 精确路由表（宿主在那里做
    // fence + 会话鉴权），本插件既不再往 webServer 直注册，也不再自己写 401/403。
    assert.equal(env.rawRoutes.length, 0)
    for (const route of env.routes) assert.ok(route.path.startsWith(`${ROUTE_PREFIX}/`))
    assert.equal(routeOf(env.routes, '/api/dsh-skills-manager/does-not-exist'), undefined, '不存在的端点不该被本插件接管')
    // 方法不对时官方通道根本不会分发（纯文本 404）：插件里因此没有"方法判断"这一分支。
    // 测试夹具复刻同一条规则，否则会以为未声明的方法也能进我们的 handler。
    const wrongMethod = await env.request('POST', '/api/dsh-skills-manager/catalog')
    assert.equal(wrongMethod.statusCode, 404)
    assert.equal(wrongMethod.text, 'not found')
  } finally {
    env.cleanup()
  }
})

test('catalog 返回解析用的 cwd 与候选目录列表', async () => {
  // 服务端在没有 cwd 时会退化成"取某个会话的 cwd"。会话可能有多个、顺序也不稳定，
  // 所以界面必须能看到它用的是哪个目录，并在多于一个时自己选 —— 否则项目级技能根
  // 会在用户毫无察觉的情况下换一套。
  const sessions = {
    list: () => [
      { header: { cwd: 'F:/project/alpha' } },
      { header: { cwd: 'f:/project/alpha/' } }, // Windows 上等价，必须去重
      { header: { cwd: 'F:/project/beta' } },
      { header: { cwd: '   ' } },
      { header: {} },
    ],
  }
  const env = await boot({ sessions })
  try {
    const response = await env.request('GET', '/api/dsh-skills-manager/catalog')
    assert.deepEqual(Array.from(response.data.candidates), ['F:/project/alpha', 'F:/project/beta'])
    assert.equal(response.data.cwd, 'F:/project/alpha', '默认取第一个')

    const explicit = await env.request('GET', `/api/dsh-skills-manager/catalog?cwd=${encodeURIComponent('F:/project/beta')}`)
    assert.equal(explicit.data.cwd, 'F:/project/beta', '显式指定的 cwd 优先')
  } finally {
    env.cleanup()
  }
})

test('没有会话时候选列表为空，而不是编一个出来', async () => {
  const env = await boot({ sessions: { list: () => [] } })
  try {
    const response = await env.request('GET', '/api/dsh-skills-manager/catalog')
    assert.deepEqual(Array.from(response.data.candidates), [], '没有会话就没有候选，不该凭空造一个')
    // cwd 会退化成运行时的默认目录 —— 这是合理的兜底，但它必须**如实出现在响应里**，
    // 界面据此告诉用户项目根是按哪个目录解析的，而不是让人以为用的就是自己的项目。
    assert.equal(typeof response.data.cwd, 'string')
    assert.ok(response.data.cwd.length > 0)
  } finally {
    env.cleanup()
  }
})

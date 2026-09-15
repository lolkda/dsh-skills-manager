/**
 * 插件级端到端测试：走真实注册表 + 真实文件系统，只把 cordis 与 HTTP 外壳换成手写的
 * 最小替身。
 *
 * 换掉外壳是有意的：这里要验的是**本插件的连线**（apply 注册了什么、路由怎么应答、
 * 状态怎么落盘），而不是 cordis 或 express 是否正确 —— 那些有它们自己的测试。
 * `/registry` 一路仍然打到真的 `ctx.skills`，所以「启停是否真的生效」在这里是被
 * 真实验证的，而不是被断言成「我们写了状态文件」。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { apply } from '../lib/index.js'
import { validateHost } from '../lib/routes.js'

/**
 * 搭起整套环境：临时 DSH_HOME、真实注册表、被捕获的路由与工具。
 * @returns {Promise<object>} 环境
 */
async function boot(options = {}) {
  const agents = options.agents
  const deferWebServer = options.deferWebServer === true
  const deferTools = options.deferTools === true
  let lateWebServer = false
  let lateTools = false
  const pending = []
  const webServerService = {
    register(spec) {
      routes.push(spec)
      return () => {
        routes.length = 0
      }
    },
  }
  const toolsService = {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-plugin-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'plain'), { recursive: true })
  mkdirSync(join(home, 'skills', 'locked'), { recursive: true })
  writeFileSync(join(home, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: 普通技能\n---\n普通正文\n')
  writeFileSync(
    join(home, 'skills', 'locked', 'SKILL.md'),
    '---\nname: locked\ndescription: 文件声明不可被模型调用\ndisable-model-invocation: true\n---\n锁定正文\n',
  )

  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  for (let i = 0; i < 40 && !ctx.skills; i++) await new Promise((r) => setTimeout(r, 25))

  const routes = []
  const tools = []
  const effectDisposers = []
  const fakeCtx = {
    skills: ctx.skills,
    effect(fn) {
      const dispose = fn()
      effectDisposers.push(dispose)
      return dispose
    },
    get(service) {
      // deferWebServer 模拟真机上真实发生过的时序：插件被挂载时 webServer 还没出现。
      if (service === 'webServer') return deferWebServer && !lateWebServer ? undefined : webServerService
      if (service === 'tools') return deferTools && !lateTools ? undefined : toolsService
      if (service === 'webRuntime') return { trustedHosts: [] }
      // 只有显式传入时才提供 agents 服务，用来覆盖 /registry 的「有 agent」分支。
      if (service === 'agents') return agents
      return undefined
    },
    inject(services, callback) {
      pending.push({ services, callback })
      return () => {}
    },
    on() {
      return () => {}
    },
  }

  apply(fakeCtx, { dshHome: home, agentsHome, includeDefaultRoots: true, log: false })

  return {
    dir,
    home,
    cwd,
    routes,
    tools,
    pending,
    registry: ctx.skills,
    registryReady: Boolean(ctx.skills),
    /**
     * 让此前缺失的服务突然出现，并触发所有在等它的延迟注入。
     * @param {string[]} services - 出现的服务名
     * @returns {void}
     */
    provide(services) {
      for (const service of services) {
        if (service === 'webServer') lateWebServer = true
        if (service === 'tools') lateTools = true
      }
      const still = []
      for (const item of pending.splice(0)) {
        if (item.services.every((service) => fakeCtx.get(service) !== undefined)) item.callback(fakeCtx)
        else still.push(item)
      }
      pending.push(...still)
    },
    request: (method, path, body, host = '127.0.0.1:3080') => call(routes[0], method, path, body, host),
    cleanup: () => {
      for (const dispose of effectDisposers) if (typeof dispose === 'function') dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 造一个最小请求对象。
 * @param {object} options - 请求参数
 * @returns {object} 请求
 */
function makeReq({ method, url, body, host }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host }
  req.resume = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

/**
 * 造一个最小响应对象。
 * @returns {object} 响应
 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.chunks.push(text)
    },
    body() {
      return JSON.parse(this.chunks.join(''))
    },
  }
}

/**
 * 打一次请求。
 * @param {object} route - 捕获到的路由定义
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径
 * @param {object} [body] - 请求体
 * @param {string} [host] - Host 头
 * @returns {Promise<{ statusCode: number, body: object }>} 响应
 */
async function call(route, method, path, body, host = '127.0.0.1:3080') {
  assert.ok(route, '路由没有注册')
  const res = makeRes()
  await route.handler(makeReq({ method, url: path, body, host }), res)
  return { statusCode: res.statusCode, ...res.body() }
}

test('apply 注册了路由、工具与两个提供方', async () => {
  const env = await boot()
  try {
    assert.equal(env.registryReady, true)
    assert.equal(env.routes.length, 1)
    assert.equal(env.routes[0].kind, 'prefix')
    assert.equal(env.routes[0].path, '/dsh-skills-manager')
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

test('webServer 晚于插件就绪时，路由会等它出现再注册', async () => {
  // 这就是真机上真实发生过的时序：cordis 只等声明过的服务，插件先挂载，webServer 后到。
  // 曾经的做法是当场 `ctx.get('webServer')` 拿到 undefined 就静默放弃 —— 服务端一切正常，
  // 日志一片干净，只是每个请求都 404。
  const env = await boot({ deferWebServer: true, deferTools: true })
  try {
    assert.equal(env.routes.length, 0, '服务未就绪时不该注册')
    assert.equal(env.pending.length, 2, '应当挂起两处延迟注入等待服务')
    env.provide(['webServer', 'tools'])
    assert.equal(env.routes.length, 1, 'webServer 出现后路由必须补上')
    assert.equal(env.tools.length, 7, 'tools 出现后工具必须补上')
    const response = await env.request('GET', '/dsh-skills-manager/catalog')
    assert.equal(response.ok, true)
  } finally {
    env.cleanup()
  }
})

test('GET /registry 没有 agent 时退回宿主层视图', async () => {
  const env = await boot()
  try {
    const response = await env.request('GET', '/dsh-skills-manager/registry')
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

  const env = await boot({ agents: { list: () => [{ id: 'agent-1', ctx: agentCtx }] } })
  try {
    const seen = []
    const original = env.registry.snapshot.bind(env.registry)
    env.registry.snapshot = async (options) => {
      seen.push(options)
      return original(options)
    }
    const response = await env.request('GET', '/dsh-skills-manager/registry')
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
    const response = await env.request('GET', '/dsh-skills-manager/registry')
    assert.equal(response.data.agents[0].count, null)
    assert.match(response.data.agents[0].reason, /作用域标识/)
  } finally {
    env.cleanup()
  }
})

test('GET /catalog 返回根、技能与回收站视图', async () => {
  const env = await boot()
  try {
    const response = await env.request('GET', '/dsh-skills-manager/catalog')
    assert.equal(response.statusCode, 200)
    assert.equal(response.ok, true)
    const names = response.data.skills.map((s) => s.name)
    assert.ok(names.includes('plain'))
    assert.ok(names.includes('locked'))
    const plain = response.data.skills.find((s) => s.name === 'plain')
    assert.equal(plain.winner, true)
    assert.equal(plain.effectiveModelInvocable, true)
    assert.deepEqual(response.data.trash, [])
    assert.ok(response.data.roots.some((r) => r.key === 'dsh'))
  } finally {
    env.cleanup()
  }
})

test('POST /policy 停用后，注册表的真实裁决随之改变', async () => {
  const env = await boot()
  try {
    const before = await env.request('GET', '/dsh-skills-manager/registry')
    assert.equal(before.data.skills.find((s) => s.name === 'plain').modelInvocable, true)

    const response = await env.request('POST', '/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'plain', enabled: false })
    assert.equal(response.ok, true, response.error)

    const after = await env.request('GET', '/dsh-skills-manager/registry')
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
    const response = await env.request('POST', '/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'locked', enabled: true })
    assert.equal(response.ok, true, response.error)
    const registry = await env.request('GET', '/dsh-skills-manager/registry')
    assert.equal(registry.data.skills.find((s) => s.name === 'locked').modelInvocable, true)
    assert.ok(readFileSync(join(env.home, 'skills', 'locked', 'SKILL.md'), 'utf8').includes('disable-model-invocation'), '文件里那句仍然在')
  } finally {
    env.cleanup()
  }
})

test('POST /skill/create 落盘，重复创建被拒', async () => {
  const env = await boot()
  try {
    const created = await env.request('POST', '/dsh-skills-manager/skill/create', {
      rootKey: 'dsh',
      name: 'Brand New',
      description: '新建的技能',
      body: '正文',
    })
    assert.equal(created.ok, true, created.error)
    assert.equal(created.name, 'brand-new')
    assert.equal(existsSync(join(env.home, 'skills', 'brand-new', 'SKILL.md')), true)
    assert.ok(created.catalog.skills.some((s) => s.name === 'brand-new'))

    const again = await env.request('POST', '/dsh-skills-manager/skill/create', { rootKey: 'dsh', name: 'brand-new', description: 'x' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'skill.exists')
  } finally {
    env.cleanup()
  }
})

test('POST /skill/save 拒绝会弄坏技能的正文', async () => {
  const env = await boot()
  try {
    const broken = await env.request('POST', '/dsh-skills-manager/skill/save', {
      rootKey: 'dsh',
      name: 'plain',
      content: '彻底没有 frontmatter',
    })
    assert.equal(broken.ok, false)
    assert.equal(broken.code, 'document.invalid')
    assert.match(readFileSync(join(env.home, 'skills', 'plain', 'SKILL.md'), 'utf8'), /普通技能/)

    const saved = await env.request('POST', '/dsh-skills-manager/skill/save', {
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

test('回收站路由：移入、恢复', async () => {
  const env = await boot()
  try {
    const trashed = await env.request('POST', '/dsh-skills-manager/skill/trash', { rootKey: 'dsh', name: 'plain' })
    assert.equal(trashed.ok, true, trashed.error)
    assert.equal(existsSync(join(env.home, 'skills', 'plain')), false)
    assert.equal(trashed.catalog.trash.length, 1)
    const id = trashed.catalog.trash[0].id

    const restored = await env.request('POST', '/dsh-skills-manager/trash/restore', { id })
    assert.equal(restored.ok, true, restored.error)
    assert.equal(existsSync(join(env.home, 'skills', 'plain', 'SKILL.md')), true)
  } finally {
    env.cleanup()
  }
})

test('删除技能会一并清掉它的启停覆盖', async () => {
  const env = await boot()
  try {
    await env.request('POST', '/dsh-skills-manager/policy', { rootKey: 'dsh', name: 'plain', enabled: false })
    await env.request('POST', '/dsh-skills-manager/skill/trash', { rootKey: 'dsh', name: 'plain' })
    const state = JSON.parse(readFileSync(join(env.home, 'dsh-skills-manager', 'state.json'), 'utf8'))
    assert.deepEqual(state.overrides.dsh ?? {}, {}, '同名技能以后重建时不该继承旧的停用状态')
  } finally {
    env.cleanup()
  }
})

test('未知 rootKey 与非回环 Host 被拒绝', async () => {
  const env = await boot()
  try {
    const unknown = await env.request('POST', '/dsh-skills-manager/policy', { rootKey: 'nope', name: 'plain', enabled: false })
    assert.equal(unknown.code, 'root.unknown')

    const forbidden = await env.request('GET', '/dsh-skills-manager/catalog', undefined, 'evil.example.com')
    assert.equal(forbidden.statusCode, 403)
    assert.equal(forbidden.code, 'host.forbidden')
  } finally {
    env.cleanup()
  }
})

test('validateHost 放行回环与受信主机', () => {
  assert.equal(validateHost({ headers: { host: '127.0.0.1:3080' } }), null)
  assert.equal(validateHost({ headers: { host: 'localhost:3080' } }), null)
  assert.equal(validateHost({ headers: { host: '127.0.0.1:3080' } }, []), null)
  assert.equal(validateHost({ headers: { host: 'box.local:3080' } }, ['box.local']), null)
  assert.equal(validateHost({ headers: { host: 'box.local:3080' } }, []).statusCode, 403)
  assert.equal(validateHost({ headers: {} }).statusCode, 403)
})

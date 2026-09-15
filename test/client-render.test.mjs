/**
 * 浏览器半边的行为测试。
 *
 * `client.test.mjs` 验证的是契约（注册了什么、依赖了什么），这一份验证的是**数据流**：
 * 挂载时拉目录、把技能渲染出来、点开关发出正确的请求、失败时把错误显示出来。
 *
 * 用本仓库里的迷你渲染器（`helpers/client-harness.mjs`）真实执行函数组件与 hooks ——
 * 不是把界面渲染成字符串就完事，也不是假装渲染成功。视觉呈现仍然只能在浏览器里看，
 * 这里覆盖的是最容易出错、也最值得测试的那一层。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { findAll, findFirst, loadClient, makeFetch, textOf } from './helpers/client-harness.mjs'

/**
 * 一条技能记录。
 * @param {object} overrides - 覆盖字段
 * @returns {object} 记录
 */
function skill(overrides) {
  return {
    source: 'user-dsh',
    rootKey: 'dsh',
    rank: 400,
    scope: 'user',
    kind: 'bundle',
    loadable: true,
    winner: true,
    shadowed: false,
    override: null,
    effectiveModelInvocable: true,
    effectiveUserInvocable: true,
    enabled: true,
    mutable: true,
    diagnostics: [],
    ...overrides,
  }
}

/**
 * 一份最小目录响应。
 * @param {object} [overrides] - 覆盖 `data` 字段
 * @returns {object} 响应体
 */
function catalog(overrides = {}) {
  return {
    ok: true,
    data: {
      roots: [
        { key: 'dsh', source: 'user-dsh', path: 'C:\\home\\.dsh\\skills', rank: 400, exists: true, skills: [{}] },
        { key: 'agents', source: 'user-agents', path: 'C:\\home\\.agents\\skills', rank: 500, exists: true, skills: [{}] },
      ],
      skills: [
        skill({ name: 'kept', docPath: 'C:\\home\\.dsh\\skills\\kept\\SKILL.md', description: '保留的技能' }),
        skill({
          name: 'dropped',
          source: 'user-agents',
          rootKey: 'agents',
          rank: 500,
          docPath: 'C:\\home\\.agents\\skills\\dropped\\SKILL.md',
          description: '会被停用的技能',
          override: false,
          effectiveModelInvocable: false,
          effectiveUserInvocable: false,
          enabled: false,
        }),
      ],
      diagnostics: [],
      trash: [],
      damaged: null,
      logPath: null,
      ...overrides,
    },
  }
}

/** 找一个开关：它的 aria-label 里带着技能名。 */
const switchFor = (tree, name) => findAll(tree, (node) => typeof node.props?.className === 'string' && node.props.className.includes('dshsm-switch')).find((node) => String(node.props['aria-label']).includes(name))

test('挂载时拉取目录，并把技能、来源与状态渲染出来', async () => {
  const fetch = makeFetch({ '/dsh-skills-manager/catalog': catalog() })
  const client = loadClient({ fetch })
  const tree = await client.mount()

  assert.equal(
    fetch.calls.filter((call) => call.url === '/dsh-skills-manager/catalog' && call.method === 'GET').length,
    1,
    '挂载只该拉一次目录（依赖没写对时会反复拉）',
  )

  const text = textOf(tree)
  assert.match(text, /kept/, '技能名必须出现')
  assert.match(text, /dropped/)
  assert.match(text, /保留的技能/, '描述必须出现')
  assert.match(text, /user-dsh/, '来源徽标必须出现')
  assert.match(text, /回收站/, '标签页必须出现')
  assert.match(text, /手动停用/, '被覆盖过的技能要标出来')
})

test('点击开关发出精确的策略请求，并重新拉取目录', async () => {
  const fetch = makeFetch({ '/dsh-skills-manager/catalog': catalog(), '/dsh-skills-manager/policy': { ok: true, changed: true } })
  const client = loadClient({ fetch })
  const tree = await client.mount()

  const target = switchFor(tree, 'dropped')
  assert.ok(target, '应当找到 dropped 的开关')
  assert.equal(target.props['aria-checked'], 'false', 'dropped 当前是停用状态')
  assert.equal(target.props.disabled, false, '可覆盖的技能其开关必须可点')

  target.props.onClick()
  await client.update()

  const call = fetch.calls.find((item) => item.url === '/dsh-skills-manager/policy')
  assert.ok(call, '必须发出策略请求')
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.body, { rootKey: 'agents', name: 'dropped', enabled: true }, '请求体必须精确指向该技能与目标状态')
  assert.ok(
    fetch.calls.filter((item) => item.url === '/dsh-skills-manager/catalog').length >= 2,
    '改完之后必须重新拉目录，而不是相信本地状态',
  )
})

test('接口报错时把错误显示出来，而不是白屏', async () => {
  const fetch = makeFetch({ '/dsh-skills-manager/catalog': { ok: false, error: '注册表暂时不可用' } })
  const client = loadClient({ fetch })
  const tree = await client.mount()
  assert.match(textOf(tree), /注册表暂时不可用/)
})

test('被遮蔽的技能不当作生效项，且开关被禁用', async () => {
  const shadowed = skill({
    name: 'shadow',
    rootKey: 'agents',
    source: 'user-agents',
    rank: 500,
    winner: false,
    shadowed: true,
    loadable: true,
  })
  const fetch = makeFetch({
    '/dsh-skills-manager/catalog': catalog({ skills: [skill({ name: 'keeper' }), shadowed] }),
  })
  const client = loadClient({ fetch })
  const tree = await client.mount()

  const target = switchFor(tree, 'shadow')
  assert.ok(target, '被遮蔽的技能也要列出来，否则用户根本不知道它为什么没生效')
  assert.equal(target.props.disabled, true, '不是生效项时开关必须禁用，不能让用户以为自己改成功了')
  assert.match(textOf(tree), /被同名技能遮蔽|遮蔽/)
})

test('回收站标签页显示条目计数', async () => {
  const fetch = makeFetch({
    '/dsh-skills-manager/catalog': catalog({
      trash: [{ id: 'dsh/old', name: 'old', source: 'user-dsh', originalPath: 'C:\\home\\.dsh\\skills\\old', deletedAt: '2026-01-02T03:04:05.000Z' }],
    }),
  })
  const client = loadClient({ fetch })
  const tree = await client.mount()
  const trashTab = findAll(tree, (node) => node.props?.className === 'dshsm-tab').find((node) => textOf(node).includes('回收站'))
  assert.ok(trashTab, '必须有回收站标签页')
  assert.match(textOf(trashTab), /1/, '回收站计数应当显示为 1')
  assert.ok(findFirst(tree, (node) => node.props?.className === 'dshsm-switch'), '技能标签页的开关仍然在')
})

test('被 DSH 丢弃的技能显示「不可加载」并禁用开关', () => {
  // 真实案例：description 里有一段未加引号的 `): `，DSH 的 YAML 解析失败后整条丢弃。
  // 界面必须把这件事说清楚，否则用户会以为这条技能在生效。
  const broken = skill({
    name: 'broken-yaml',
    description: '坏掉的描述',
    loadable: false,
    winner: false,
    diagnostics: [{ level: 'error', code: 'frontmatter.yaml', message: '第 2 行的值无法作为 YAML 标量解析，DSH 会因此丢弃整条技能' }],
  })
  const fetch = makeFetch({ '/dsh-skills-manager/catalog': catalog({ skills: [skill({ name: 'keeper' }), broken] }) })
  const client = loadClient({ fetch })
  return client.mount().then((tree) => {
    const text = textOf(tree)
    assert.match(text, /不可加载/, '必须标出不可加载')
    const target = switchFor(tree, 'broken-yaml')
    assert.ok(target, '坏掉的技能也要列出来，否则用户根本不知道它为什么没生效')
    assert.equal(target.props.disabled, true, '不可加载时开关必须禁用')
  })
})

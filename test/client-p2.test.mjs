import assert from 'node:assert/strict'
import test from 'node:test'
import { findAll, findFirst, loadClient, makeFetch, textOf } from './helpers/client-harness.mjs'

const A = 'F:/review/a'
const B = 'F:/review/b'
const C = 'F:/review/c'
const content = '---\nname: demo\ndescription: Demo\n---\nBody\n'
function catalog(cwd = A, broken = false) {
  const name = broken ? 'broken' : `only-${cwd.slice(-1)}`
  const rootKey = `project-dsh@${cwd.toLowerCase()}`
  const skill = { name, rootKey, docPath: `${cwd}/.dsh/skills/${name}/SKILL.md`, source: 'project-dsh', rank: 100, scope: 'project', kind: 'bundle',
    description: 'Demo', winner: !broken, shadowed: false, loadable: !broken, enabled: true, mutable: true, override: null,
    fileModelInvocable: true, fileUserInvocable: true, effectiveModelInvocable: true, effectiveUserInvocable: true,
    diagnostics: broken ? [{ code: 'description.missing', level: 'error', message: '缺少 description，需修复' }] : [] }
  return { ok: true, data: { cwd, candidates: [A, B, C], roots: [
    { key: rootKey, source: 'project-dsh', rank: 100, path: `${cwd}/.dsh/skills`, mutable: true, exists: true, skills: [skill] },
    { key: 'dsh', source: 'user-dsh', rank: 400, path: 'F:/review/home/skills', mutable: true, exists: true, skills: [] },
  ], skills: [skill], diagnostics: [], damaged: null } }
}
const requestCwd = url => new URL(url, 'http://test').searchParams.get('cwd') ?? A
const byClass = (tree, name) => findFirst(tree, node => String(node.props?.className ?? '').split(' ').includes(name))
const button = (tree, label) => findFirst(tree, node => node.type === 'button' && textOf(node).trim().endsWith(label))
const skillRow = (tree, name) => findFirst(tree, node => node.props?.className === 'dshsm-row__main' && textOf(node).includes(name))
const toggle = tree => findFirst(tree, node => node.props?.role === 'switch')
async function selectCwd(client, tree, cwd) {
  byClass(tree, 'dshsm-select__trigger').props.onClick()
  tree = await client.update()
  const item = findAll(tree, node => node.props?.role === 'menuitem').find(node => textOf(node).includes(cwd))
  assert.ok(item)
  item.props.onClick()
  return client.update()
}

// Each test names a production transition that was missing, not a mock call count.
test('P2：切换项目必须清理旧项目的 root 过滤器', async () => {
  const fetch = makeFetch({ '/dsh-skills-manager/catalog': ({ url }) => catalog(requestCwd(url)) })
  const client = loadClient({ fetch })
  let tree = await client.mount()
  button(tree, 'project-dsh · 1').props.onClick()
  tree = await client.update()
  assert.ok(skillRow(tree, 'only-a'))
  tree = await selectCwd(client, tree, B)
  assert.ok(skillRow(tree, 'only-b'), 'B has a skill; an A root filter must not hide it')
})

test('P2：启停失败信息不会被后续成功的 GET 清掉', async () => {
  const client = loadClient({ fetch: makeFetch({
    '/dsh-skills-manager/catalog': catalog(),
    '/dsh-skills-manager/policy': { ok: false, error: 'policy-denied-test' },
  }) })
  let tree = await client.mount()
  toggle(tree).props.onClick(); tree = await client.update()
  assert.match(textOf(tree), /policy-denied-test/)
})

test('P2：删除失败保留错误和详情，不伪装成删除成功', async () => {
  const client = loadClient({ fetch: makeFetch({
    '/dsh-skills-manager/catalog': catalog(),
    '/dsh-skills-manager/skill/delete': { ok: false, error: 'delete-denied-test' },
  }) })
  let tree = await client.mount()
  skillRow(tree, 'only-a').props.onClick(); tree = await client.update()
  button(tree, '删除').props.onClick(); tree = await client.update()
  await button(tree, '确认删除').props.onClick(); tree = await client.update()
  assert.match(textOf(tree), /delete-denied-test/)
  assert.ok(byClass(tree, 'dshsm-detail'))
})

test('P2：读取编辑正文的网络错误可见且不产生未处理拒绝', async () => {
  const client = loadClient({ fetch: makeFetch({
    '/dsh-skills-manager/catalog': catalog(),
    '/dsh-skills-manager/skill/content': () => { throw new Error('read-offline-test') },
  }) })
  let tree = await client.mount()
  skillRow(tree, 'only-a').props.onClick(); tree = await client.update()
  await button(tree, '编辑正文').props.onClick().catch(() => {})
  tree = await client.update()
  assert.match(textOf(tree), /read-offline-test/)
})

test('P2：上传读取失败时解除 busy，用户可取消并重试', async () => {
  const client = loadClient({ fetch: makeFetch({ '/dsh-skills-manager/catalog': catalog() }) })
  let tree = await client.mount()
  button(tree, '导入技能').props.onClick(); tree = await client.update()
  const input = findFirst(tree, node => node.type === 'input' && node.props.type === 'file')
  await input.props.onChange({ target: { value: 'file', files: [{ name: 'broken.md', text: async () => { throw new Error('read-file-test') } }] } }).catch(() => {})
  tree = await client.update()
  assert.equal(findFirst(tree, node => node.type === 'input' && node.props.type === 'file').props.disabled, false)
  assert.equal(button(tree, '取消').props.disabled, false)
  assert.match(textOf(tree), /read-file-test/)
})

test('P2：不可加载技能可展开诊断和编辑，不误称为同名遮蔽', async () => {
  const response = catalog(A, true)
  const fetch = makeFetch({
    '/dsh-skills-manager/catalog': response,
    '/dsh-skills-manager/skill/content': { ok: true, content, path: response.data.skills[0].docPath },
  })
  const client = loadClient({ fetch })
  let tree = await client.mount()
  assert.doesNotMatch(textOf(tree), /1 条被同名技能遮蔽/)
  skillRow(tree, 'broken').props.onClick(); tree = await client.update()
  assert.match(textOf(tree), /缺少 description，需修复/)
  assert.ok(button(tree, '编辑正文'))
  await button(tree, '编辑正文').props.onClick(); tree = await client.update()
  assert.ok(byClass(tree, 'dshsm-editor'))
  const request = fetch.calls.find(item => item.url.includes('/skill/content'))
  assert.equal(new URL(request.url, 'http://test').searchParams.get('docPath'), response.data.skills[0].docPath)
})

test('P2：损坏技能的详情不能宣称当前模型可用', async () => {
  const client = loadClient({ fetch: makeFetch({ '/dsh-skills-manager/catalog': catalog(A, true) }) })
  let tree = await client.mount()
  skillRow(tree, 'broken').props.onClick(); tree = await client.update()
  const values = findAll(byClass(tree, 'dshsm-kv'), node => node.type === 'dd')
  assert.equal(values.length, 4)
  assert.match(textOf(values[3]), /未生效/)
})

test('P2：同名但调用策略不同必须显示红色核对结果', async () => {
  const client = loadClient({ fetch: makeFetch({
    '/dsh-skills-manager/catalog': catalog(),
    '/dsh-skills-manager/registry': { ok: true, data: { divergence: {
      checked: true, ours: 1, registry: 1, missing: [], extra: [], consistent: false,
      policyMismatches: ['only-a'], sourceMismatches: [], checkedPolicies: 1,
    } } },
  }) })
  const tree = await client.mount()
  assert.match(textOf(byClass(tree, 'dshsm-notice--danger')), /only-a/)
  assert.equal(byClass(tree, 'dshsm-notice--ok'), undefined)
})

test('P2：无法安全迁移的旧 custom 覆盖必须显示全局警告', async () => {
  const response = catalog()
  response.data.diagnostics = [{ level: 'warn', code: 'override.legacyCustom', message: 'legacy-custom-review-warning' }]
  const client = loadClient({ fetch: makeFetch({ '/dsh-skills-manager/catalog': response }) })
  const tree = await client.mount()
  assert.match(textOf(byClass(tree, 'dshsm-notice--warn')), /legacy-custom-review-warning/)
})

test('P2：慢的旧项目响应不能覆盖后来选择的项目', async () => {
  const gate = Promise.withResolvers()
  const client = loadClient({ fetch: async url => {
    if (!url.includes('/catalog')) return { status: 200, json: async () => ({ ok: false }) }
    const cwd = requestCwd(url)
    if (cwd === B) await gate.promise
    return { status: 200, json: async () => catalog(cwd) }
  } })
  try {
    let tree = await client.mount()
    tree = await selectCwd(client, tree, B)
    tree = await selectCwd(client, tree, C)
    assert.ok(skillRow(tree, 'only-c'), 'fixture: the newer C response must have arrived')
    gate.resolve()
    tree = await client.update()
    assert.ok(skillRow(tree, 'only-c'), 'late B response must be discarded')
    assert.equal(skillRow(tree, 'only-b'), undefined)
  } finally { gate.resolve(); await client.flush() }
})

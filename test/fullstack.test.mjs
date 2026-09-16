/**
 * 全链路测试：界面表单 → 真实路由 → 磁盘。
 *
 * 为什么需要它：两边的测试此前各测各的 —— 客户端测的是"渲染对不对"，服务端测的是"接口对不对"，
 * 中间靠**字段名**连着，而那个契约**从来没人验过**。客户端表单此前连一次都没被驱动过（只有渲染），
 * 服务端的 `/skill/import`、`/skill/content`、`/skill/delete` 也没有任何 HTTP 层测试。
 *
 * 这里把客户端发出的真实请求**直接喂给真实路由**，然后到磁盘上看结果 —— 字段名写错、路径写错、
 * 少传一个参数，都会在这里现形。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { boot } from './helpers/host-harness.mjs'
import { findAll, findFirst, loadClient, textOf } from './helpers/client-harness.mjs'

/**
 * 把客户端的 fetch 接到真实路由上。
 * @param {object} env - 宿主测试环境
 * @returns {{ fetch: Function, calls: object[] }} 适配器与调用记录
 */
function bridge(env) {
  const calls = []
  return {
    calls,
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET'
      const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : undefined
      calls.push({ url, method, body })
      const payload = await env.request(method, url, body)
      return { ok: true, status: payload.statusCode ?? 200, json: async () => payload }
    },
  }
}

/**
 * 取一个节点**自己的**文本（不含 className）。
 *
 * 不能直接用 `textOf`：它把 className 也拼进了结果，于是按钮文案变成
 * `dshsm-btn dshsm-btn--primary 新建技能`，永远等不上「新建技能」。
 * @param {object} node - 节点
 * @returns {string} 文本
 */
const labelOf = (node) => (Array.isArray(node.children) ? node.children.map(textOf).join(' ') : '').trim()

/**
 * 按按钮文案前缀找节点。
 *
 * 按钮文案可能有装饰性前缀（「＋ 新建技能」），精确相等匹配不上 —— 而且匹配不上时用 `?.` 会静默
 * 什么都不做，测试就变成了空转。
 * @param {object} tree - 渲染树
 * @param {string} prefix - 文案前缀
 * @returns {object|undefined} 节点
 */
const buttonStartingWith = (tree, prefix) => findFirst(tree, (node) => node.type === 'button' && labelOf(node).startsWith(prefix))

/**
 * 按按钮文案找节点。
 *
 * 先精确匹配；没有再退到「以该文案结尾」—— 按钮上可能有装饰性前缀（比如添加入口的
 * `＋ `），那种前缀是观感，不该让行为测试失败。
 * @param {object} tree - 渲染树
 * @param {string} label - 文案
 * @returns {object|undefined} 节点
 */
const buttonByText = (tree, label) =>
  findFirst(tree, (node) => node.type === 'button' && labelOf(node) === label) ??
  findFirst(tree, (node) => node.type === 'button' && labelOf(node).endsWith(label))

/**
 * 按 class 找节点。
 * @param {object} tree - 渲染树
 * @param {string} name - class 片段
 * @returns {object|undefined} 节点
 */
const byClass = (tree, name) => findFirst(tree, (node) => String(node.props?.className ?? '').includes(name))

/**
 * 往一个受控输入里写值，并返回重渲染后的树。
 *
 * 关键是每次都用**新树上的节点**：表单是 `setFields({ ...fields, [key]: value })`，
 * 拿着更新前的旧节点连写两次，闭包里还是那份旧 `fields`，第二次会把第一次覆盖掉。
 * 真浏览器里每个事件各自触发一次渲染，所以这里也逐个重新定位 + update。
 * @param {object} client - 客户端夹具
 * @param {object} tree - 当前渲染树
 * @param {(tree: object) => object|undefined} find - 在当前树里重新定位输入节点
 * @param {string} value - 值
 * @returns {Promise<object>} 新的渲染树
 */
async function fill(client, tree, find, value) {
  const node = find(tree)
  assert.ok(node, '找不到要填的输入框')
  node.props.onChange({ target: { value } })
  return client.update()
}

/**
 * 在表单里按顺序取第 index 个输入框。
 * @param {number} index - 序号
 * @returns {(tree: object) => object|undefined} 定位函数
 */
const formInput = (index) => (tree) => findAll(byClass(tree, 'dshsm-form'), (node) => node.type === 'input')[index]

/**
 * 取新建表单里的正文文本域（容器是 `dshsm-form`）。
 * @param {object} tree - 渲染树
 * @returns {object|undefined} 节点
 */
const createTextarea = (tree) => findFirst(byClass(tree, 'dshsm-form'), (node) => node.type === 'textarea')

/**
 * 取正文编辑器里的文本域。
 *
 * 编辑器的容器是 `dshsm-editor` —— 与新建表单的 `dshsm-form` 不是同一个 class，
 * 按 `dshsm-form` 找会扑空。
 * @param {object} tree - 渲染树
 * @returns {object|undefined} 节点
 */
const formTextarea = (tree) => findFirst(byClass(tree, 'dshsm-editor'), (node) => node.type === 'textarea')

/**
 * 选中一条技能，让详情面板出现。
 * @param {object} client - 客户端夹具
 * @param {object} tree - 当前渲染树
 * @param {string} name - 技能名
 * @returns {Promise<object>} 新的渲染树
 */
async function selectSkill(client, tree, name) {
  const row = findFirst(tree, (node) => node.props?.role === 'button' && String(node.props?.className ?? '').includes('dshsm-row__main') && textOf(node).includes(name))
  assert.ok(row, `找不到技能行：${name}`)
  row.props.onClick()
  return client.update()
}

test('界面新建技能：字段真的走到了磁盘上', async () => {
  const env = await boot()
  try {
    const { fetch, calls } = bridge(env)
    const client = loadClient({ fetch })
    let tree = await client.mount()

    buttonByText(tree, '新建技能').props.onClick()
    tree = await client.update()

    const form = byClass(tree, 'dshsm-form')
    assert.ok(form, '点了「新建技能」应当出现表单')
    const inputs = findAll(form, (node) => node.type === 'input')
    const textarea = findFirst(form, (node) => node.type === 'textarea')
    assert.equal(inputs.length, 3, '三个输入框：名字、描述、何时使用')
    assert.equal(inputs[0].props.placeholder, 'my-skill')

    tree = await fill(client, tree, formInput(0), 'ui-created')
    tree = await fill(client, tree, formInput(1), '由界面创建，用来验证字段名没写错')
    tree = await fill(client, tree, createTextarea, ['# 正文', '', '正文内容'].join(String.fromCharCode(10)))
    tree = await client.update()

    const submit = buttonByText(tree, '创建')
    assert.ok(submit, '找得到创建按钮')
    assert.equal(submit.props.disabled, false, '填完了就该能点')
    submit.props.onClick()
    await client.update()

    const createCall = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/create'))
    assert.ok(createCall, '应当发出创建请求')
    // 与服务端 dispatch 读的字段逐个对上 —— 少一个或多一个都会在这里现形。
    assert.deepEqual(Object.keys(createCall.body).sort(), ['body', 'description', 'name', 'rootKey', 'whenToUse'])
    assert.equal(createCall.body.name, 'ui-created')

    // 名字会走规范化：技能名必须是 kebab-case。中文名会被拒，这里用合法名字。
    assert.equal(existsSync(join(env.home, 'skills', 'ui-created', 'SKILL.md')), true, '磁盘上应当出现这个技能')
    assert.match(readFileSync(join(env.home, 'skills', 'ui-created', 'SKILL.md'), 'utf8'), /name: ui-created/)

  } finally {
    env.cleanup()
  }
})

test('界面导入技能：从路径导入走过的字段是真的', async () => {
  const env = await boot()
  try {
    // 先造一个源目录，供界面里的路径输入框指过去。
    const source = join(env.dir, 'source', 'ui-imported')
    mkdirSync(source, { recursive: true })
    writeFileSync(join(source, 'SKILL.md'), ['---', 'name: ui-imported', 'description: 由界面导入', '---', '', '正文', ''].join('\n'))

    const { fetch, calls } = bridge(env)
    const client = loadClient({ fetch })
    let tree = await client.mount()

    buttonByText(tree, '导入技能').props.onClick()
    tree = await client.update()

    // 表单里第一个 input 是 `type=file`，路径输入框是第二个 —— 按 placeholder 找更稳。
    const pathField = (current) =>
      findFirst(byClass(current, 'dshsm-form'), (node) => node.type === 'input' && typeof node.props?.placeholder === 'string' && node.props.placeholder.includes('skills'))
    assert.ok(pathField(tree), '找得到路径输入框')
    tree = await fill(client, tree, pathField, source)
    const go = buttonByText(tree, '从路径导入')
    assert.ok(go, '找得到从路径导入按钮')
    go.props.onClick()
    await client.update()

    const imported = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/import'))
    assert.ok(imported, '应当发出导入请求')
    assert.deepEqual(Object.keys(imported.body).sort(), ['kind', 'overwrite', 'path', 'rootKey'])
    assert.equal(imported.body.kind, 'path')
    assert.equal(imported.body.path, source)
    assert.equal(existsSync(join(env.home, 'skills', 'ui-imported', 'SKILL.md')), true, '导入结果要落到磁盘上')
  } finally {
    env.cleanup()
  }
})

test('界面查看与保存正文：改动落盘，界面里也读得到', async () => {
  const env = await boot()
  try {
    const { fetch, calls } = bridge(env)
    const client = loadClient({ fetch })
    let tree = await client.mount()

    tree = await selectSkill(client, tree, 'plain')
    const edit = buttonByText(tree, '编辑正文')
    assert.ok(edit, '应当在详情里有编辑入口')
    edit.props.onClick()
    await client.update()
    tree = await client.update()

    const contentCall = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/content'))
    assert.ok(contentCall, '读正文的请求要带上 rootKey 与 name')
    assert.match(contentCall.url, /rootKey=/)
    assert.match(contentCall.url, /name=/)

    const textarea = formTextarea(tree)
    assert.ok(textarea, '编辑器要给一个 textarea')
    assert.match(String(textarea.props.value), /name: plain/, '编辑器里应当是这条技能的原文')

    const marker = '界面改的标记'
    const next = String(textarea.props.value).replace(/^description:.*$/m, `description: ${marker}`)
    assert.notEqual(next, textarea.props.value, '构造出了改动')
    tree = await fill(client, tree, formTextarea, next)

    buttonByText(tree, '保存').props.onClick()
    await client.update()

    const save = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/save'))
    assert.ok(save, '应当发出保存请求')
    assert.deepEqual(Object.keys(save.body).sort(), ['content', 'name', 'rootKey'])
    assert.match(save.body.content, new RegExp(marker))
  } finally {
    env.cleanup()
  }
})

test('界面删除技能：先确认，再永久删除', async () => {
  const env = await boot()
  try {
    const { fetch, calls } = bridge(env)
    const client = loadClient({ fetch })
    let tree = await client.mount()

    const doomed = join(env.home, 'skills', 'plain', 'SKILL.md')
    assert.equal(existsSync(doomed), true, '前提：plain 这条技能存在')

    tree = await selectSkill(client, tree, 'plain')
    const remove = buttonByText(tree, '删除')
    assert.ok(remove, '详情里应当有删除入口')

    // 没有回收站了，删就是真删 —— 所以第一下**不能**直接删。
    remove.props.onClick()
    tree = await client.update()
    assert.equal(existsSync(doomed), true, '第一次点击只该进入确认态，文件必须还在')
    assert.equal(calls.some((call) => call.url.includes('/skill/delete')), false, '确认之前不该发出删除请求')
    assert.match(textOf(tree), /不可撤销/, '要把"不可撤销"这话说出来')

    const confirm = buttonByText(tree, '确认删除')
    assert.ok(confirm, '确认态里应当有「确认删除」')
    confirm.props.onClick()
    await client.update()
    tree = await client.update()

    const deleteCall = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/delete'))
    assert.ok(deleteCall, '应当发出删除请求')
    assert.deepEqual(Object.keys(deleteCall.body).sort(), ['name', 'rootKey'])
    assert.equal(existsSync(doomed), false, '确认之后文件必须真的没了')
    assert.equal(existsSync(join(env.home, 'skills', 'plain')), false, 'bundle 的整个目录都要没了')
  } finally {
    env.cleanup()
  }
})

test('界面新建：名字非法时把话说出来，而不是静默什么都不发生', async () => {
  // 技能名必须是 kebab-case。中文名会被服务端拒掉 —— 界面必须把这句话显示出来，
  // 否则用户点完「创建」看到界面一动不动，只会以为按钮坏了。
  const env = await boot()
  try {
    const { fetch, calls } = bridge(env)
    const client = loadClient({ fetch })
    let tree = await client.mount()

    buttonByText(tree, '新建技能').props.onClick()
    tree = await client.update()
    tree = await fill(client, tree, formInput(0), '界面建的技能')
    tree = await fill(client, tree, formInput(1), '名字非法')
    tree = await fill(client, tree, createTextarea, '正文')

    buttonByText(tree, '创建').props.onClick()
    tree = await client.update()
    tree = await client.update()

    const createCall = calls.find((call) => call.url.startsWith('/dsh-skills-manager/skill/create'))
    assert.ok(createCall, '请求本身要发出去')
    const notice = byClass(tree, 'dshsm-notice--danger')
    assert.ok(notice, '服务端拒绝之后界面要显示错误')
    assert.ok(textOf(notice).trim().length > 10, '错误信息不能是空话')
  } finally {
    env.cleanup()
  }
})

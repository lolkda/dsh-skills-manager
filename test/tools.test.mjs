/**
 * 七个 Agent 工具的真调用测试。
 *
 * 为什么必须逐个**真的调一次**：此前测试只断言过"工具注册了、有 execute"。而真机会话里
 * 模型根本调不动它们（本机没有 API key，模型不会回一个工具调用），所以这套 CRUD 的**执行
 * 路径**从头到尾没被跑过 —— 连参数名写错都发现不了。工具是目标里明确列的一项能力，
 * 「注册成功」远不等于「叫得动、且干的是它说的事」。
 *
 * 这里连 `output.render` 一起测：它是给模型看的最终文本，错了模型就收到一句废话。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertSupportedJsonSchema, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'

import { createRuntime, RUNTIME_KEY } from '../lib/index.js'
import { overrideFor } from '../lib/store.js'
import { installTools } from '../lib/tools.js'
import { makeZip } from '../spike/make-zip.mjs'

/** 用户技能根：新建与导入默认落在这里。 */
const USER_ROOT = 'dsh'

/** 换行符。用拼接而不是字面量，免得跨层转义把内容吃掉。 */
const LF = String.fromCharCode(10)

/**
 * 造一份技能文档。
 * @param {string} name - 技能名
 * @param {string} description - 描述
 * @param {string} [body] - 正文
 * @returns {string} 文档
 */
function doc(name, description, body = '正文') {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join(LF)
}

/**
 * 起一个装了工具、指向临时目录的运行时。
 * @returns {object} 夹具
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-tools-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  const registered = []
  const logger = []
  const runtime = createRuntime({
    dshHome: home,
    agentsHome,
    includeDefaultRoots: true,
    log: false,
    appendLog: (_path, entry) => logger.push(entry),
  })
  const ctx = { [RUNTIME_KEY]: runtime }
  const tools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  installTools(ctx, tools, runtime)

  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  return {
    dir,
    home,
    cwd,
    registered,
    logger,
    runtime,
    /**
     * 按名字调一个工具，并把它渲染出的文本一起返回。
     * @param {string} name - 工具名
     * @param {object} [args] - 参数
     * @returns {Promise<{ value: object, text: string }>} 结果
     */
    async call(name, args = {}) {
      const definition = byName.get(name)
      assert.ok(definition, `没有注册名为 ${name} 的工具`)
      const value = await definition.execute({ cwd, ...args })
      const rendered = definition.output.render(args, value)
      assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} 的 render 必须给出内容`)
      assert.equal(rendered[0].type, 'text')
      assert.equal(typeof rendered[0].text, 'string')
      return { value, text: rendered[0].text }
    },
    /**
     * 读一条技能的文件内容。
     * @param {string} name - 技能名
     * @returns {string|undefined} 内容
     */
    read(name) {
      const path = join(home, 'skills', name, 'SKILL.md')
      return existsSync(path) ? readFileSync(path, 'utf8') : undefined
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('注册了七个工具，且每个都带 output.render', () => {
  const env = setup()
  try {
    assert.deepEqual(
      Array.from(env.registered, (item) => item.name).sort(),
      ['skills_create', 'skills_delete', 'skills_get', 'skills_import', 'skills_list', 'skills_set_enabled', 'skills_update'],
    )
    for (const definition of env.registered) {
      // 缺 render 会在注册期抛错，把整个 profile 带崩 —— 这里逐个钉住。
      assert.deepEqual(Object.keys(definition.output).sort(), ['render', 'schema'])
      assert.equal(typeof definition.output.render, 'function')
      assert.equal(typeof definition.description, 'string')
      assert.ok(definition.description.length > 20, `${definition.name} 的描述太短，模型没法判断何时用它`)
      assert.equal(typeof definition.parameters, 'object')
    }
  } finally {
    env.cleanup()
  }
})

test('skills_create → skills_list → skills_get 串起来真的建了文件', async () => {
  const env = setup()
  try {
    const created = await env.call('skills_create', {
      name: 'tool-created',
      description: '由工具创建的技能',
      body: '# 正文\n\n这里是内容。\n',
    })
    assert.equal(created.value.ok, true, JSON.stringify(created.value))
    assert.match(env.read('tool-created'), /name: tool-created/)

    const listed = await env.call('skills_list')
    assert.equal(listed.value.ok, true)
    assert.match(listed.text, /tool-created/, '列出的文本里应当有它')

    const got = await env.call('skills_get', { name: 'tool-created' })
    assert.equal(got.value.ok, true)
    assert.match(got.text, /这里是内容/, '取回的正文要真的包含写进去的内容')
  } finally {
    env.cleanup()
  }
})

test('skills_update 改写正文，改的是磁盘上的文件', async () => {
  const env = setup()
  try {
    await env.call('skills_create', { name: 'tool-updated', description: '改前', body: '旧正文' })
    const updated = await env.call('skills_update', {
      name: 'tool-updated',
      content: '---\nname: tool-updated\ndescription: 改后\n---\n\n新正文\n',
    })
    assert.equal(updated.value.ok, true, JSON.stringify(updated.value))
    const text = env.read('tool-updated')
    assert.match(text, /改后/)
    assert.match(text, /新正文/)
    assert.equal(text.includes('旧正文'), false, '旧内容不该还在')
  } finally {
    env.cleanup()
  }
})

test('skills_update 拒绝会写坏的文档，且不碰磁盘', async () => {
  const env = setup()
  try {
    await env.call('skills_create', { name: 'tool-guarded', description: '正常', body: '正文' })
    const before = env.read('tool-guarded')
    const bad = await env.call('skills_update', {
      name: 'tool-guarded',
      content: '---\nname: tool-guarded\ndescription: 参考 macOS): 冒号后跟空格\n---\n\n正文\n',
    })
    assert.equal(bad.value.ok, false, '会写坏的文档必须被拒绝')
    assert.equal(env.read('tool-guarded'), before, '被拒绝的写入不能碰磁盘')
    assert.match(bad.text, /失败/, '模型收到的应该是一句明确的失败说明')
  } finally {
    env.cleanup()
  }
})

test('每个工具的参数 schema 都落在 DSH 支持的子集里', () => {
  const env = setup()
  try {
    for (const definition of env.registered) {
      // 用 **DSH 自己的校验器**，而不是我照着源码重写一遍规则：规则会随 DSH 变，重写的那份不会。
      // 这就是 `type: ['boolean','null']` 当初溜进来的地方 —— `ctx.tools.register` 只校验
      // `output.schema`，**完全不看 parameters**，所以注册期一路绿灯。
      assertSupportedJsonSchema(definition.parameters)
      // 而且参数表要能渲染成真实类型。DSH 有一整套按 schema 渲染 TS/Python 签名的路径
      // （PTC 模式），类型数组会让整份参数渲染成 `unknown` —— 模型看到的参数表形同没有。
      const rendered = jsonSchemaToTs(definition.parameters)
      assert.equal(rendered.includes('unknown'), false, `${definition.name} 的参数渲染出了 unknown：${rendered}`)
    }
  } finally {
    env.cleanup()
  }
})

test('skills_set_enabled 真的改了策略，而且没有动源文件', async () => {
  const env = setup()
  try {
    const created = await env.call('skills_create', { name: 'tool-toggle', description: '启停用', body: '正文' })
    assert.equal(created.value.ok, true)
    const before = env.read('tool-toggle')

    const off = await env.call('skills_set_enabled', { name: 'tool-toggle', enabled: false })
    assert.equal(off.value.ok, true, JSON.stringify(off.value))
    assert.equal(overrideFor(env.runtime.state, 'dsh', 'tool-toggle'), false, '覆盖真的落到了状态里')
    assert.equal(env.read('tool-toggle'), before, '停用绝不能改源文件')

    const on = await env.call('skills_set_enabled', { name: 'tool-toggle', enabled: true })
    assert.equal(on.value.ok, true)
    assert.equal(overrideFor(env.runtime.state, 'dsh', 'tool-toggle'), true)

    // 三种状态：false 停用、true 启用、**省略**清除覆盖。
    const cleared = await env.call('skills_set_enabled', { name: 'tool-toggle' })
    assert.equal(cleared.value.ok, true)
    assert.equal(overrideFor(env.runtime.state, 'dsh', 'tool-toggle'), undefined, '清除后不该留下一条 null')
    assert.equal(env.read('tool-toggle'), before)

    // 从"已停用"直接省略也要能清除，而不是被当成 falsy 去停用。
    await env.call('skills_set_enabled', { name: 'tool-toggle', enabled: false })
    assert.equal(overrideFor(env.runtime.state, 'dsh', 'tool-toggle'), false)
    await env.call('skills_set_enabled', { name: 'tool-toggle' })
    assert.equal(overrideFor(env.runtime.state, 'dsh', 'tool-toggle'), undefined, '省略要从任何状态回到"跟随文件"')
  } finally {
    env.cleanup()
  }
})

test('skills_delete 永久删除，磁盘上不留痕迹', async () => {
  const env = setup()
  try {
    await env.call('skills_create', { name: 'tool-doomed', description: '待删', body: '正文' })
    const deleted = await env.call('skills_delete', { name: 'tool-doomed' })
    assert.equal(deleted.value.ok, true, JSON.stringify(deleted.value))
    assert.equal(existsSync(join(env.home, 'skills', 'tool-doomed')), false, 'bundle 的整个目录都要没了')

    const listed = await env.call('skills_list')
    assert.equal(listed.text.includes('tool-doomed'), false, '删掉之后不该还列着它')
  } finally {
    env.cleanup()
  }
})

test('skills_import 能吃下 Markdown 文件、目录与 ZIP', async () => {
  const env = setup()
  try {
    // 工具只吃路径 —— 它给的是 agent 一个"把本地东西装进来"的入口，不接受内联内容。
    writeFileSync(join(env.dir, 'note.md'), doc('tool-md', '从单文件导入'))
    const byFile = await env.call('skills_import', { path: join(env.dir, 'note.md') })
    assert.equal(byFile.value.ok, true, JSON.stringify(byFile.value))
    assert.match(env.read('tool-md'), /name: tool-md/)

    const sourceDir = join(env.dir, 'folder', 'tool-folder')
    mkdirSync(sourceDir, { recursive: true })
    writeFileSync(join(sourceDir, 'SKILL.md'), doc('tool-folder', '从目录导入'))
    writeFileSync(join(sourceDir, 'extra.md'), '附件')
    const byDir = await env.call('skills_import', { path: sourceDir })
    assert.equal(byDir.value.ok, true, JSON.stringify(byDir.value))
    assert.match(env.read('tool-folder'), /name: tool-folder/)
    assert.equal(existsSync(join(env.home, 'skills', 'tool-folder', 'extra.md')), true, '目录里的附件要一起搬过来')

    const archive = join(env.dir, 'bundle.zip')
    writeFileSync(archive, makeZip([{ name: 'tool-zipped/SKILL.md', data: doc('tool-zipped', '从 ZIP 导入'), deflate: true }]))
    const byZip = await env.call('skills_import', { path: archive })
    assert.equal(byZip.value.ok, true, JSON.stringify(byZip.value))
    assert.match(env.read('tool-zipped'), /name: tool-zipped/)

    // 不存在的路径要给出可读的失败，而不是抛异常。
    const missing = await env.call('skills_import', { path: join(env.dir, '没有这个文件.zip') })
    assert.equal(missing.value.ok, false)
    assert.match(missing.text, /失败：/)
  } finally {
    env.cleanup()
  }
})

test('参数不对时给出可读的失败，而不是抛异常', async () => {
  const env = setup()
  try {
    const noName = await env.call('skills_get', {})
    assert.equal(noName.value.ok, false)
    assert.match(noName.text, /失败：/)

    const unknown = await env.call('skills_get', { name: '根本不存在的技能' })
    assert.equal(unknown.value.ok, false)

    // 工具**不接受** rootKey：它只写用户根，这是刻意的 —— 不该让模型随手挑一个根去写。
    // 参数表里写了 additionalProperties: false，多传的字段会被框架挡在门外。
    const definition = env.registered.find((item) => item.name === 'skills_create')
    assert.equal('rootKey' in definition.parameters.properties, false)
    assert.equal(definition.parameters.additionalProperties, false)

    // 名字非法要拦住，而不是写出一堆奇怪的目录。
    const badName = await env.call('skills_create', { name: '   ', description: 'y', body: 'z' })
    assert.equal(badName.value.ok, false)
  } finally {
    env.cleanup()
  }
})

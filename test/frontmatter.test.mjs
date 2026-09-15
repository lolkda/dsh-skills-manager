import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildSkillDocument,
  isSkillName,
  normalizeSkillName,
  parseBoolean,
  parseFrontmatter,
  readSkillDocument,
  splitDocument,
} from '../lib/frontmatter.js'

test('isSkillName 只接受 kebab-case', () => {
  assert.equal(isSkillName('grill-me'), true)
  assert.equal(isSkillName('a1-b2'), true)
  assert.equal(isSkillName('Grill-Me'), false)
  assert.equal(isSkillName('grill_me'), false)
  assert.equal(isSkillName('-lead'), false)
  assert.equal(isSkillName('中文'), false)
})

test('normalizeSkillName 把常见输入折叠成合法名字', () => {
  assert.equal(normalizeSkillName('  My New Skill '), 'my-new-skill')
  assert.equal(normalizeSkillName('snake_case_name'), 'snake-case-name')
  assert.equal(normalizeSkillName('already-kebab'), 'already-kebab')
  assert.equal(normalizeSkillName('中文技能'), '')
  assert.equal(normalizeSkillName('My 技能 v2'), 'my-v2')
})

test('splitDocument 识别有无 frontmatter 与未闭合', () => {
  assert.deepEqual(splitDocument('just text').hasFrontmatter, false)
  const ok = splitDocument('---\nname: a\n---\nbody\n')
  assert.equal(ok.hasFrontmatter, true)
  assert.equal(ok.closed, true)
  assert.equal(ok.frontmatter, 'name: a')
  assert.equal(ok.body, 'body\n')
  const bad = splitDocument('---\nname: a\nbody\n')
  assert.equal(bad.hasFrontmatter, true)
  assert.equal(bad.closed, false)
})

test('splitDocument 容忍 BOM 与 CRLF', () => {
  const doc = splitDocument('\uFEFF---\r\nname: a\r\n---\r\nx\r\n')
  assert.equal(doc.hasFrontmatter, true)
  assert.equal(doc.closed, true)
  assert.equal(doc.frontmatter, 'name: a')
})

test('parseBoolean 拒绝被引用的布尔值', () => {
  assert.equal(parseBoolean('true', false), true)
  assert.equal(parseBoolean('YES', false), true)
  assert.equal(parseBoolean('off', false), false)
  assert.equal(parseBoolean('1', false), true)
  assert.equal(parseBoolean('true', true), undefined)
  assert.equal(parseBoolean('maybe', false), undefined)
})

test('parseFrontmatter 解析标量、引号与块标量', () => {
  const { entries } = parseFrontmatter(
    ['name: demo', 'description: "带: 冒号 与 # 井号"', 'whenToUse: >', '  第一行', '  第二行', 'metadata:', '  key: value'].join('\n'),
  )
  assert.equal(entries.get('name').value, 'demo')
  assert.equal(entries.get('description').value, '带: 冒号 与 # 井号')
  assert.equal(entries.get('description').quoted, true)
  assert.equal(entries.get('whenToUse').value, '第一行 第二行')
  assert.equal(entries.has('metadata'), true)
})

test('readSkillDocument 给出与注册表一致的判定', () => {
  const good = readSkillDocument('---\nname: demo-skill\ndescription: A demo.\n---\nBody here.\n')
  assert.equal(good.loadable, true)
  assert.equal(good.name, 'demo-skill')
  assert.equal(good.modelInvocable, true)
  assert.equal(good.userInvocable, true)
  assert.equal(good.body.trim(), 'Body here.')
  assert.deepEqual(good.diagnostics, [])

  const modelOff = readSkillDocument('---\nname: demo\ndescription: x\ndisable-model-invocation: true\n---\nx\n')
  assert.equal(modelOff.modelInvocable, false)
  assert.equal(modelOff.userInvocable, true)
  assert.equal(modelOff.loadable, true)

  const userOff = readSkillDocument('---\nname: demo\ndescription: x\nuser-invocable: "no"\n---\nx\n')
  assert.equal(userOff.userInvocable, true, '被引用的 no 是字符串，不是布尔值')

  const userOffReal = readSkillDocument('---\nname: demo\ndescription: x\nuser-invocable: no\n---\nx\n')
  assert.equal(userOffReal.userInvocable, false)
})

test('readSkillDocument 对损坏文档给出可修复的诊断', () => {
  const missing = readSkillDocument('no frontmatter at all')
  assert.equal(missing.loadable, false)
  assert.equal(missing.diagnostics[0].code, 'frontmatter.missing')

  const badName = readSkillDocument('---\nname: Bad_Name\ndescription: x\n---\n')
  assert.equal(badName.loadable, false)
  assert.ok(badName.diagnostics.some((d) => d.code === 'name.invalid'))

  const noDescription = readSkillDocument('---\nname: fine\n---\n')
  assert.equal(noDescription.loadable, false)
  assert.ok(noDescription.diagnostics.some((d) => d.code === 'description.missing'))

  const badBool = readSkillDocument('---\nname: fine\ndescription: x\ndisable-model-invocation: "true"\n---\n')
  assert.equal(badBool.loadable, false)
  assert.equal(badBool.invocationPolicyValid, false)
  assert.ok(badBool.diagnostics.some((d) => d.code === 'invocation.invalid'))
})

test('buildSkillDocument 产出的文档能被自己读回', () => {
  const text = buildSkillDocument({
    name: 'My 新 Skill',
    description: 'A demo: with a colon # and a dash - start',
    whenToUse: 'whenever',
    body: 'Step one.\n',
  })
  const read = readSkillDocument(text)
  assert.equal(read.name, 'my-skill')
  assert.equal(read.description, 'A demo: with a colon # and a dash - start')
  assert.equal(read.whenToUse, 'whenever')
  assert.equal(read.loadable, true)
  assert.equal(read.body, 'Step one.\n')
})

// ── 与 DSH 的真实解析器保持一致 ──────────────────────────────────────────────
// DSH 用真正的 `yaml` 库解析 frontmatter，任何解析失败都会让**整条技能被丢弃**。
// 本模块是手写子集，只要比它宽松一点，界面就会声称一条模型从未收到过的技能"生效"。
// 真机上就发生过：apple-liquid-glass 的长描述里有 `macOS): light grey-white ground`，
// 冒号后跟空格在 YAML 里是嵌套映射，DSH 直接丢弃，而我们当时报 loadable=true。

test('值里未加引号的冒号会让整条技能被判为不可加载', () => {
  const doc = readSkillDocument('---\nname: demo\ndescription: 参考 macOS): 浅灰白底\n---\n正文\n')
  assert.equal(doc.loadable, false, 'DSH 会丢弃它，我们也必须这么说')
  const hit = doc.diagnostics.find((item) => item.code === 'frontmatter.yaml')
  assert.ok(hit, '必须给出 frontmatter.yaml 诊断')
  assert.equal(hit.level, 'error')
  assert.match(hit.message, /DSH 会因此丢弃/)
})

test('加了引号的冒号是合法的，不受影响', () => {
  const doc = readSkillDocument('---\nname: demo\ndescription: "参考 macOS): 浅灰白底"\n---\n正文\n')
  assert.equal(doc.loadable, true, `引号包住的标量里冒号不构成嵌套映射：${JSON.stringify(doc.diagnostics)}`)
  assert.equal(doc.description, '参考 macOS): 浅灰白底')
})

test('URL 里的冒号不误伤', () => {
  const doc = readSkillDocument('---\nname: demo\ndescription: 见 https://example.com/docs 的说明\n---\n正文\n')
  assert.equal(doc.loadable, true, '冒号后跟斜杠不是嵌套映射')
})

test('解析不了的行按错误处理，而不是告警', () => {
  const doc = readSkillDocument('---\nname: demo\ndescription: 说明\n这一行没有冒号\n---\n正文\n')
  assert.equal(doc.loadable, false)
  const hit = doc.diagnostics.find((item) => item.code === 'frontmatter.line')
  assert.ok(hit)
  assert.equal(hit.level, 'error', 'DSH 会丢弃整条技能，这里报成 warn 就等于骗人')
})

test('任何 error 级诊断都会让 loadable 为假', () => {
  for (const text of [
    '---\nname: demo\n---\n正文\n',
    '---\ndescription: 有描述没名字\n---\n正文\n',
    '---\nname: demo\ndescription: 说明\ndisable-model-invocation: "true"\n---\n正文\n',
  ]) {
    const doc = readSkillDocument(text)
    assert.equal(doc.loadable, false, `应当不可加载：${JSON.stringify(text)}`)
  }
})

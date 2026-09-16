import assert from 'node:assert/strict'
import test from 'node:test'

import { readZip, safeEntryPath } from '../lib/zip.js'

import { makeZip } from '../spike/make-zip.mjs'

test('readZip 读出存储与 deflate 两种条目', () => {
  const buffer = makeZip([
    { name: 'demo/SKILL.md', data: '---\nname: demo\ndescription: x\n---\n正文\n' },
    { name: 'demo/references/a.md', data: '参考内容', deflate: true },
    { name: 'demo/', data: '' },
  ])
  const result = readZip(buffer)
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  const byName = new Map(result.entries.map((e) => [e.name, e]))
  assert.equal(byName.get('demo/SKILL.md').data.toString('utf8').includes('name: demo'), true)
  assert.equal(byName.get('demo/references/a.md').data.toString('utf8'), '参考内容')
  assert.equal(byName.get('demo').isDirectory, true)
})

test('readZip 对损坏与非 ZIP 输入明确失败', () => {
  assert.equal(readZip(Buffer.from('not a zip at all, really')).ok, false)
  const truncated = makeZip([{ name: 'a.md', data: 'x' }]).subarray(0, 20)
  assert.equal(readZip(truncated).ok, false)
})

test('safeEntryPath 挡住 zip-slip 与 Windows 特例', () => {
  assert.equal(safeEntryPath('demo/SKILL.md'), 'demo/SKILL.md')
  assert.equal(safeEntryPath('./demo//x.md'), 'demo/x.md')
  assert.equal(safeEntryPath('demo\\SKILL.md'), 'demo/SKILL.md', '反斜杠必须先统一，否则 ..\\ 能绕过检查')
  assert.equal(safeEntryPath('../evil.md'), null)
  assert.equal(safeEntryPath('..\\..\\evil.md'), null)
  assert.equal(safeEntryPath('/etc/passwd'), 'etc/passwd', '前导斜杠被剥掉，落点仍在根内')
  assert.equal(safeEntryPath('C:/Windows/x'), null)
  assert.equal(safeEntryPath('demo/CON.md'), null)
  assert.equal(safeEntryPath('demo/trailing.'), null)
  assert.equal(safeEntryPath(''), null)
})

test('readZip 拒绝含穿越路径的归档', () => {
  const buffer = makeZip([{ name: '../../evil.md', data: 'x' }])
  const result = readZip(buffer)
  assert.equal(result.ok, false)
  assert.match(result.error, /不安全/)
})

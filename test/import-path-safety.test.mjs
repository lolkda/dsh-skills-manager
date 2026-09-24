/**
 * 导入落点校验：既要允许"旧附件文件被同名目录取代"，也要挡住越出技能根的落点。
 *
 * 这两件事由同一个函数裁决（`within` → `canonicalDestination`），所以必须一起测：
 * 放宽 ENOTDIR 这种"父项是普通文件"的情形，不能顺带放过符号链接父级或越根条目。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { importFiles } from '../lib/operations.js'

const doc = (name, body = 'Body') => `---\nname: ${name}\ndescription: Fixture\n---\n${body}\n`
const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8') }

/** 一个只含技能根的临时目录。 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-import-path-'))
  const rootPath = join(dir, 'skills')
  mkdirSync(rootPath, { recursive: true })
  return {
    dir,
    root: { path: rootPath, key: 'dsh' },
    cleanup() { rmSync(dir, { recursive: true, force: true }) },
  }
}

const bundle = (name, entries) => ({
  root: undefined,
  overwrite: true,
  files: [{ name: 'SKILL.md', data: Buffer.from(doc(name, 'NEW')) }, ...entries.map(([entry, text]) => ({ name: entry, data: Buffer.from(text) }))],
})

test('覆盖导入允许旧附件文件被同名目录取代', () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo/SKILL.md'), doc('demo'))
    // 旧版本把这个附件存成了一个普通文件；新包里它是 data/child.txt。
    put(join(f.root.path, 'demo/data'), 'old file')
    const result = importFiles({ ...bundle('demo', [['data/child.txt', 'new child']]), root: f.root })
    assert.equal(result.ok, true, result.error)
    assert.equal(readFileSync(join(f.root.path, 'demo/data/child.txt'), 'utf8'), 'new child')
  } finally { f.cleanup() }
})

test('父级是指向根外的符号链接时仍然拒绝', () => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside')
    mkdirSync(outside, { recursive: true })
    put(join(f.root.path, 'demo/SKILL.md'), doc('demo'))
    symlinkSync(outside, join(f.root.path, 'demo/data'), 'dir')
    const result = importFiles({ ...bundle('demo', [['data/child.txt', 'escaped']]), root: f.root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape', `越根的符号链接父级必须拒绝，得到 ${JSON.stringify(result)}`)
    assert.equal(readFileSync(join(f.root.path, 'demo/SKILL.md'), 'utf8'), doc('demo'), '拒绝时原技能必须原样保留')
  } finally { f.cleanup() }
})

test('父级是指向根外普通文件的符号链接时仍然拒绝', () => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside.txt')
    writeFileSync(outside, 'outside', 'utf8')
    put(join(f.root.path, 'demo/SKILL.md'), doc('demo'))
    symlinkSync(outside, join(f.root.path, 'demo/data'), 'file')
    const result = importFiles({ ...bundle('demo', [['data/child.txt', 'escaped']]), root: f.root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape', `越根的符号链接父级必须拒绝，得到 ${JSON.stringify(result)}`)
  } finally { f.cleanup() }
})

test('条目名带 .. 的越根路径仍然拒绝', () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo/SKILL.md'), doc('demo'))
    const result = importFiles({ ...bundle('demo', [['../escaped.txt', 'escaped']]), root: f.root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape', `越根条目必须拒绝，得到 ${JSON.stringify(result)}`)
  } finally { f.cleanup() }
})

test('条目名是指向根外的绝对符号链接时仍然拒绝', () => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside')
    mkdirSync(outside, { recursive: true })
    put(join(f.root.path, 'demo/SKILL.md'), doc('demo'))
    // 目标目录本身合法，但里面已有的链接把写入引到根外。
    mkdirSync(join(f.root.path, 'demo/data'), { recursive: true })
    symlinkSync(join(outside, 'child.txt'), join(f.root.path, 'demo/data/child.txt'), 'file')
    const result = importFiles({ ...bundle('demo', [['data/child.txt', 'escaped']]), root: f.root })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape', `写入落在根外符号链接上时必须拒绝，得到 ${JSON.stringify(result)}`)
  } finally { f.cleanup() }
})

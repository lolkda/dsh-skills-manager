import assert from 'node:assert/strict'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createRuntime } from '../lib/index.js'
import { installRoutes } from '../lib/routes.js'
import { statePath, storeDir } from '../lib/store.js'
import { createSkill, importFiles } from '../lib/operations.js'
import { call } from './helpers/host-harness.mjs'
import { makeZip } from '../spike/make-zip.mjs'

const document = name => `---\nname: ${name}\ndescription: Safe fixture\n---\nOriginal body\n`
const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, 'utf8') }
function fixture(readOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-mutation-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'project')
  mkdirSync(cwd)
  const runtime = createRuntime({ dshHome: home, agentsHome: join(dir, 'agents'), log: false,
    ...(readOnly ? { includeDefaultRoots: false, bundledSkillDir: join(dir, 'bundled') } : {}) })
  runtime.setDefaultCwd(cwd)
  let route
  installRoutes({ get: name => name === 'webRuntime' ? { trustedHosts: [] } : undefined }, {
    register(spec) { route = spec; return () => {} },
  }, runtime)
  const root = runtime.rootsFor(cwd).find(item => item.key === (readOnly ? 'bundled' : 'dsh'))
  return { dir, home, cwd, root, runtime, request: (method, path, body) => call(route, method, `/dsh-skills-manager${path}`, body), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('HTTP 保存不能绕过 bundled 根的只读限制', async () => {
  const f = fixture(true)
  try {
    const path = join(f.root.path, 'demo', 'SKILL.md')
    put(path, document('demo'))
    const result = await f.request('POST', '/skill/save', { rootKey: f.root.key, name: 'demo', content: document('demo') + 'Changed' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'root.readOnly')
    assert.equal(readFileSync(path, 'utf8'), document('demo'))
  } finally { f.cleanup() }
})

test('HTTP 保存不能沿文档符号链接写到根外', async t => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside.md')
    put(outside, document('demo'))
    const path = join(f.root.path, 'demo', 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    try { symlinkSync(outside, path, 'file') } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS denies fixture symlink creation')
      throw error
    }
    const result = await f.request('POST', '/skill/save', { rootKey: f.root.key, name: 'demo', content: document('demo') + 'Changed' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape')
    assert.equal(readFileSync(outside, 'utf8'), document('demo'))
  } finally { f.cleanup() }
})

test('HTTP 保存不能通过硬链接改动根外同一文件', async t => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside.md')
    const path = join(f.root.path, 'demo', 'SKILL.md')
    const original = document('demo')
    const changed = original + 'Changed'
    put(outside, original)
    mkdirSync(dirname(path), { recursive: true })
    try { linkSync(outside, path) } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('OS denies fixture hardlink creation')
      throw error
    }
    const result = await f.request('POST', '/skill/save', { rootKey: 'dsh', name: 'demo', content: changed })
    assert.equal(readFileSync(outside, 'utf8'), original, 'a root-local pathname must not mutate its outside hardlink alias')
    if (result.ok) assert.equal(readFileSync(path, 'utf8'), changed, 'atomic replacement may safely detach the root-local name')
    else assert.match(result.error, /硬链接|hard.?link|多重链接/i, 'explicit refusal must explain the file alias')
  } finally { f.cleanup() }
})

test('新建不能穿过指向根外的目录链接', t => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside')
    mkdirSync(outside); mkdirSync(f.root.path, { recursive: true })
    try { symlinkSync(outside, join(f.root.path, 'demo'), process.platform === 'win32' ? 'junction' : 'dir') } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS denies fixture symlink creation')
      throw error
    }
    const result = createSkill({ root: f.root, name: 'demo', description: 'No escape', overwrite: true })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'path.escape')
    assert.equal(existsSync(join(outside, 'SKILL.md')), false)
  } finally { f.cleanup() }
})

test('写盘失败不发布内存策略，排除障碍后同参数重试会真正保存', async () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo', 'SKILL.md'), document('demo'))
    put(storeDir(f.home), 'blocks directory creation')
    let invalidations = 0
    f.runtime.invalidators.add(() => { invalidations++ })
    const first = await f.request('POST', '/policy', { rootKey: f.root.key, name: 'demo', enabled: false })
    assert.equal(first.statusCode, 500)
    assert.equal(f.runtime.catalogFor(f.cwd).winners.get('demo').enabled, true)
    assert.equal(invalidations, 0)
    rmSync(storeDir(f.home))
    const retry = await f.request('POST', '/policy', { rootKey: f.root.key, name: 'demo', enabled: false })
    assert.equal(retry.ok, true)
    assert.equal(retry.changed, true)
    assert.equal(JSON.parse(readFileSync(statePath(f.home), 'utf8')).overrides.dsh.demo.enabled, false)
    assert.equal(invalidations, 1, 'success still invalidates immediately')
  } finally { f.cleanup() }
})

test('清除覆盖写盘失败也不提前清空内存状态', async () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo', 'SKILL.md'), document('demo'))
    assert.equal((await f.request('POST', '/policy', { rootKey: 'dsh', name: 'demo', enabled: false })).ok, true)
    const saved = statePath(f.home)
    renameSync(saved, saved + '.backup')
    mkdirSync(saved)
    const first = await f.request('POST', '/policy', { rootKey: 'dsh', name: 'demo', enabled: null })
    assert.equal(first.statusCode, 500)
    assert.equal(f.runtime.catalogFor(f.cwd).winners.get('demo').enabled, false)
    rmSync(saved, { recursive: true }); renameSync(saved + '.backup', saved)
    const retry = await f.request('POST', '/policy', { rootKey: 'dsh', name: 'demo', enabled: null })
    assert.equal(retry.changed, true)
    assert.deepEqual(JSON.parse(readFileSync(saved, 'utf8')).overrides, {})
  } finally { f.cleanup() }
})

test('覆盖 ZIP 写入中途失败时保留原文档及全部附件', async () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo', 'SKILL.md'), document('demo'))
    put(join(f.root.path, 'demo', 'keep.txt'), 'keep')
    const zip = makeZip([
      { name: 'SKILL.md', data: document('demo') + 'Replacement' },
      { name: 'collision', data: 'file' },
      { name: 'collision/child.txt', data: 'cannot mkdir over file' },
    ])
    const result = await f.request('POST', '/skill/import', { rootKey: 'dsh', kind: 'zip', overwrite: true, base64: zip.toString('base64') })
    assert.equal(result.ok, false)
    assert.equal(readFileSync(join(f.root.path, 'demo', 'SKILL.md'), 'utf8'), document('demo'))
    assert.equal(readFileSync(join(f.root.path, 'demo', 'keep.txt'), 'utf8'), 'keep')
  } finally { f.cleanup() }
})

test('成功覆盖导入替换整个包并保留新附件', () => {
  const f = fixture()
  try {
    put(join(f.root.path, 'demo', 'SKILL.md'), document('demo'))
    put(join(f.root.path, 'demo', 'old.txt'), 'old')
    const result = importFiles({ root: f.root, overwrite: true, files: [
      { name: 'demo/SKILL.md', data: Buffer.from(document('demo') + 'Replacement') },
      { name: 'demo/new.txt', data: Buffer.from('new') },
    ] })
    assert.equal(result.ok, true, result.error)
    assert.equal(existsSync(join(f.root.path, 'demo', 'old.txt')), false)
    assert.equal(readFileSync(join(f.root.path, 'demo', 'new.txt'), 'utf8'), 'new')
  } finally { f.cleanup() }
})

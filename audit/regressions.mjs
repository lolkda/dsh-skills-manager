/**
 * Review-only regression specifications. These assert the intended behavior and
 * deliberately fail on the reviewed revision. Not part of `npm test` discovery.
 * Run: node --test audit/regressions.mjs
 * All mutations use a fresh OS-temporary fixture, removed in finally blocks.
 * No live HTTP requests, real skill/config changes, or production patches.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { createProvider } from '../lib/provider.js'
import { buildCatalog } from '../lib/catalog.js'
import { compareWithRegistry } from '../lib/divergence.js'
import { readSkillDocument } from '../lib/frontmatter.js'
import { createRuntime } from '../lib/index.js'
import { makeZip } from '../spike/make-zip.mjs'
import { fileURLToPath } from 'node:url'
import { installRoutes } from '../lib/routes.js'
import { statePath, storeDir } from '../lib/store.js'
import { boot, call } from '../test/helpers/host-harness.mjs'
import { findAll, findFirst, loadClient, makeFetch, textOf } from '../test/helpers/client-harness.mjs'

const doc = (name, description = 'Review fixture', extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\nFixture body\n`
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8') }
function fixture(configFor = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-review-'))
  const home = join(dir, 'home')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  const settings = { dshHome: home, agentsHome: join(dir, 'agents'), log: false, ...configFor(dir) }
  const runtime = createRuntime(settings)
  runtime.setDefaultCwd(cwd)
  let route
  installRoutes({ get: (name) => name === 'webRuntime' ? { trustedHosts: [] } : undefined }, {
    register(spec) { route = spec; return () => {} },
  }, runtime)
  return { dir, home, cwd, settings, runtime, request: (method, path, body) => call(route, method, path, body), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
const endpoint = (name, cwd) => `/dsh-skills-manager/${name}${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ''}`
function bridge(env) {
  return async (url, init = {}) => {
    const result = await env.request(init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : undefined)
    return { status: result.statusCode, json: async () => result }
  }
}
function byClass(tree, className) { return findFirst(tree, node => String(node.props?.className ?? '').split(' ').includes(className)) }
function button(tree, text) { return findFirst(tree, node => node.type === 'button' && textOf(node).trim().endsWith(text)) }
function switchFor(tree, name) { return findFirst(tree, node => node.props?.role === 'switch' && String(node.props['aria-label']).endsWith(` ${name}`)) }
async function chooseCwd(client, tree, cwd) {
  byClass(tree, 'dshsm-select__trigger').props.onClick()
  tree = await client.update()
  const item = findAll(tree, node => node.props?.role === 'menuitem').find(node => textOf(node).includes(cwd))
  assert.ok(item, 'fixture: cwd choice must exist')
  item.props.onClick()
  return client.update()
}

// Control proves that the fixture routes, disk and state round-trip actually work.
test('CONTROL: ordinary ASCII-path create and policy persistence work', async () => {
  const f = fixture()
  try {
    const created = await f.request('POST', endpoint('skill/create'), { rootKey: 'dsh', name: 'normal', description: 'Control' })
    assert.equal(created.ok, true)
    const result = await f.request('POST', endpoint('policy'), { rootKey: 'dsh', name: 'normal', enabled: false })
    assert.equal(result.ok, true)
    assert.equal(JSON.parse(readFileSync(statePath(f.home), 'utf8')).overrides.dsh.normal.enabled, false)
  } finally { f.cleanup() }
})

test('R01: a Host header alone must not authorize skill mutations', async () => {
  const f = fixture()
  try {
    // call() supplies Host only: no cookie, authorization, token or Origin.
    const result = await f.request('POST', endpoint('skill/create'), { rootKey: 'dsh', name: 'unauthenticated', description: 'No credential supplied' })
    assert.equal(result.ok, false, `unauthenticated mutation accepted; fileExists=${existsSync(join(f.home, 'skills', 'unauthenticated', 'SKILL.md'))}`)
    assert.ok([401, 403].includes(result.statusCode))
  } finally { f.cleanup() }
})

test('R02: HTTP save must preserve a bundled read-only document', async () => {
  const f = fixture(dir => ({ includeDefaultRoots: false, bundledSkillDir: join(dir, 'bundled') }))
  try {
    const path = join(f.dir, 'bundled', 'readonly', 'SKILL.md')
    const before = doc('readonly')
    put(path, before)
    assert.equal(f.runtime.rootsFor(f.cwd)[0].mutable, false)
    const result = await f.request('POST', endpoint('skill/save'), { rootKey: 'bundled', name: 'readonly', content: doc('readonly', 'Changed by HTTP') })
    assert.equal(readFileSync(path, 'utf8'), before, `read-only document changed, result.ok=${result.ok}`)
  } finally { f.cleanup() }
})

test('R03: catalog-issued root keys must work for Chinese and space-containing project paths', async () => {
  const f = fixture()
  try {
    const cwd = join(f.dir, 'project 中文 with space')
    mkdirSync(join(cwd, '.git'), { recursive: true })
    const catalog = await f.request('GET', endpoint('catalog', cwd))
    const root = catalog.data.roots.find(item => item.source === 'project-dsh')
    const result = await f.request('POST', endpoint('skill/create', cwd), { rootKey: root.key, name: 'new-skill', description: 'Valid project root' })
    assert.equal(result.ok, true, `server-issued root key rejected: ${result.code}: ${root.key}`)
  } finally { f.cleanup() }
})

test('R04: a damaged document must remain readable for repair', async () => {
  const f = fixture()
  try {
    const content = '---\nname: broken\n---\nMissing description\n'
    put(join(f.home, 'skills', 'broken', 'SKILL.md'), content)
    const catalog = await f.request('GET', endpoint('catalog'))
    assert.equal(catalog.data.skills.find(item => item.name === 'broken').loadable, false)
    const result = await f.request('GET', endpoint('skill/content') + '?rootKey=dsh&name=broken')
    assert.equal(result.ok, true, `broken file is on disk and in catalog, but read fails: ${result.code}`)
    assert.equal(result.content, content)
  } finally { f.cleanup() }
})

test('R05: retry after a storage failure must persist the policy', async () => {
  const f = fixture()
  try {
    put(join(f.home, 'skills', 'plain', 'SKILL.md'), doc('plain'))
    // A regular file prevents creation of the state directory, on Windows and POSIX.
    put(storeDir(f.home), 'temporary filesystem obstacle')
    const first = await f.request('POST', endpoint('policy'), { rootKey: 'dsh', name: 'plain', enabled: false })
    assert.equal(first.statusCode, 500, 'fixture: storage operation must really fail')
    rmSync(storeDir(f.home))
    const retry = await f.request('POST', endpoint('policy'), { rootKey: 'dsh', name: 'plain', enabled: false })
    assert.equal(retry.ok, true)
    assert.equal(existsSync(statePath(f.home)), true, `retry reported ok, changed=${retry.changed}, but state.json was never written`)
  } finally { f.cleanup() }
})

test('R06: two runtime instances sharing DSH_HOME must not lose each other\'s policies', () => {
  const f = fixture()
  try {
    put(join(f.home, 'skills', 'alpha', 'SKILL.md'), doc('alpha'))
    put(join(f.home, 'skills', 'beta', 'SKILL.md'), doc('beta'))
    const other = createRuntime(f.settings)
    assert.equal(f.runtime.setEnabled({ cwd: f.cwd, rootKey: 'dsh', name: 'alpha', enabled: false }).ok, true)
    assert.equal(other.setEnabled({ cwd: f.cwd, rootKey: 'dsh', name: 'beta', enabled: false }).ok, true)
    const saved = JSON.parse(readFileSync(statePath(f.home), 'utf8'))
    assert.deepEqual(Object.keys(saved.overrides.dsh).sort(), ['alpha', 'beta'])
  } finally { f.cleanup() }
})

test('R07: failed overwrite import must preserve the original bundle', async () => {
  const f = fixture()
  try {
    const root = f.runtime.rootsFor(f.cwd).find(item => item.key === 'dsh')
    const path = join(root.path, 'existing', 'SKILL.md')
    const before = doc('existing', 'Original must survive')
    put(path, before)
    put(join(root.path, 'existing', 'original.txt'), 'preserve me')
    const archive = makeZip([
      { name: 'SKILL.md', data: doc('existing', 'Replacement') },
      { name: 'collision', data: 'ordinary file' },
      { name: 'collision/child.txt', data: 'cannot create a directory over a file' },
    ])
    const result = await f.request('POST', endpoint('skill/import'), { rootKey: 'dsh', kind: 'zip', overwrite: true, base64: archive.toString('base64') })
    assert.equal(result.ok, false, 'fixture: real file/directory collision must cause import failure')
    assert.equal(readFileSync(path, 'utf8'), before, 'failure returned after the old bundle had already been destroyed')
    assert.equal(existsSync(join(root.path, 'existing', 'original.txt')), true)
  } finally { f.cleanup() }
})

test('R08: /registry must report the requested project, not the first agent', async () => {
  const agents = []
  const env = await boot({ agents: { list: () => agents } })
  try {
    const a = join(env.dir, 'project-a')
    const b = join(env.dir, 'project-b')
    mkdirSync(join(a, '.git'), { recursive: true }); mkdirSync(join(b, '.git'), { recursive: true })
    put(join(a, '.dsh', 'skills', 'only-a', 'SKILL.md'), doc('only-a'))
    put(join(b, '.dsh', 'skills', 'only-b', 'SKILL.md'), doc('only-b'))
    for (const [id, cwd] of [['a', a], ['b', b]]) {
      const scope = createScope(new Context(), {})
      agents.push({ id, ctx: scope.ctx, session: { header: { cwd } } })
    }
    const result = await env.request('GET', endpoint('registry', b))
    assert.equal(result.ok, true)
    assert.equal(result.data.divergence.cwd, b, 'selected B in request, but response compares A')
    assert.ok(result.data.skills.some(item => item.name === 'only-b'))
  } finally { env.cleanup() }
})

test('R09: switching project while a project-root filter is selected must show the new project', async () => {
  const cwds = []
  const env = await boot({ sessions: { list: () => cwds.map(cwd => ({ header: { cwd } })) } })
  try {
    const a = join(env.dir, 'a')
    const b = join(env.dir, 'b')
    for (const [cwd, name] of [[a, 'only-a'], [b, 'only-b']]) {
      mkdirSync(join(cwd, '.git'), { recursive: true })
      put(join(cwd, '.dsh', 'skills', name, 'SKILL.md'), doc(name))
    }
    cwds.push(a, b)
    const client = loadClient({ fetch: bridge(env) })
    let tree = await client.mount()
    const filter = findFirst(tree, node => node.type === 'button' && String(node.props.className).includes('dshsm-chip') && textOf(node).includes('project-dsh'))
    assert.ok(filter)
    filter.props.onClick(); tree = await client.update()
    assert.ok(switchFor(tree, 'only-a'), 'fixture: A filter must actually be active')
    tree = await chooseCwd(client, tree, b)
    assert.ok(switchFor(tree, 'only-b'), `new project has a skill, but stale filter shows: ${textOf(byClass(tree, 'dshsm-list-wrap'))}`)
  } finally { env.cleanup() }
})

test('R10: a failed policy request must keep its error visible after catalog reload', async () => {
  const f = fixture()
  try {
    put(join(f.home, 'skills', 'plain', 'SKILL.md'), doc('plain'))
    const realFetch = bridge(f)
    const client = loadClient({ fetch: async (url, init) => String(url).includes('/policy')
      ? { status: 200, json: async () => ({ ok: false, error: 'policy-denied-review-marker' }) }
      : realFetch(url, init) })
    let tree = await client.mount()
    switchFor(tree, 'plain').props.onClick()
    tree = await client.update()
    assert.match(textOf(tree), /policy-denied-review-marker/, 'successful GET reload must not erase the failed POST message')
  } finally { f.cleanup() }
})

async function nativeNames(f, content) {
  const root = join(f.dir, 'native')
  put(join(root, 'demo', 'SKILL.md'), content)
  const control = new AbortController()
  const provider = new FileSystemSkillProvider(new Context(), { signal: control.signal, invalidate() {} }, {
    includeDefaultRoots: false, customSkillDirs: [root], dshHome: f.home, agentsHome: join(f.dir, 'agents'), watch: false,
  })
  try {
    const result = await provider.list({ cwd: f.cwd })
    return (Array.isArray(result) ? result : result.candidates).map(item => item.name)
  } finally { control.abort(); await provider.dispose() }
}

test('R11: quoted boolean frontmatter must agree with the installed DSH parser', async () => {
  const f = fixture()
  try {
    const content = doc('demo', 'Valid YAML', 'disable-model-invocation: "true"\n')
    const names = await nativeNames(f, content)
    assert.deepEqual(names, ['demo'], 'fixture: native DSH must accept this document')
    assert.equal(readSkillDocument(content).loadable, true, 'manager rejects a document native DSH loads')
  } finally { f.cleanup() }
})

test('R12: duplicate YAML keys must be rejected before saving a document DSH will discard', async () => {
  const f = fixture()
  try {
    const content = doc('demo', 'Duplicate key', 'name: other\n')
    const names = await nativeNames(f, content)
    assert.deepEqual(names, [], 'fixture: native DSH must reject this document')
    assert.equal(readSkillDocument(content).loadable, false, 'manager accepts a document native DSH discards')
  } finally { f.cleanup() }
})

test('R13: registry policy disagreement must not be labelled consistent', () => {
  const catalog = { skills: [{ name: 'demo', winner: true, loadable: true, enabled: false, effectiveModelInvocable: false, effectiveUserInvocable: false }] }
  const real = [{ name: 'demo', provider: 'filesystem', modelInvocable: true, userInvocable: true }]
  assert.equal(compareWithRegistry(catalog, real).consistent, false, 'equal names do not imply equal enabled state')
})

test('R14: custom-root reordering must not move a saved policy to a different directory', () => {
  const f = fixture()
  try {
    const a = join(f.dir, 'custom-a'); const b = join(f.dir, 'custom-b')
    put(join(a, 'demo', 'SKILL.md'), doc('demo', 'A'))
    put(join(b, 'demo', 'SKILL.md'), doc('demo', 'B'))
    const first = createRuntime({ ...f.settings, includeDefaultRoots: false, customSkillDirs: [a, b] })
    const rootKey = first.catalogFor(f.cwd).winners.get('demo').rootKey
    assert.equal(first.setEnabled({ cwd: f.cwd, rootKey, name: 'demo', enabled: false }).ok, true)
    assert.equal(first.catalogFor(f.cwd).winners.get('demo').enabled, false, 'fixture: the original root must really be disabled')
    const reordered = createRuntime({ ...f.settings, includeDefaultRoots: false, customSkillDirs: [b, a] })
    const winner = reordered.catalogFor(f.cwd).winners.get('demo')
    assert.equal(winner.docPath, join(b, 'demo', 'SKILL.md'))
    assert.equal(winner.override, null, 'B inherited a policy the user set on A')
  } finally { f.cleanup() }
})

test('R15: create must reject a name already present as a flat Markdown skill', async () => {
  const f = fixture()
  try {
    put(join(f.home, 'skills', 'dup.md'), doc('dup', 'Existing flat skill'))
    const result = await f.request('POST', endpoint('skill/create'), { rootKey: 'dsh', name: 'dup', description: 'New bundle' })
    assert.equal(result.ok, false, `duplicate was accepted; records=${f.runtime.catalogFor(f.cwd).skills.filter(s => s.name === 'dup').length}`)
  } finally { f.cleanup() }
})

test('R16: upload file-read errors must release busy state and show an error', async () => {
  const f = fixture()
  try {
    const client = loadClient({ fetch: bridge(f) })
    let tree = await client.mount()
    button(tree, '导入技能').props.onClick(); tree = await client.update()
    const input = findFirst(tree, node => node.type === 'input' && node.props.type === 'file')
    assert.ok(input)
    await input.props.onChange({ target: { value: 'file', files: [{ name: 'broken.md', text: async () => { throw new Error('File no longer readable') } }] } }).catch(() => {})
    tree = await client.update()
    const after = findFirst(tree, node => node.type === 'input' && node.props.type === 'file')
    assert.equal(after.props.disabled, false, 'file.text rejection leaves upload and cancel permanently busy')
  } finally { f.cleanup() }
})

test('R17: importing two bundles must not overwrite the validated main document', async () => {
  const f = fixture()
  try {
    const archive = makeZip([
      { name: 'alpha/SKILL.md', data: doc('demo', 'Validated main document') },
      { name: 'bravo/SKILL.md', data: 'not a valid skill document' },
    ])
    const result = await f.request('POST', endpoint('skill/import'), { rootKey: 'dsh', kind: 'zip', base64: archive.toString('base64') })
    if (!result.ok) return // rejecting an ambiguous archive is also correct
    const installed = readFileSync(join(f.home, 'skills', 'demo', 'SKILL.md'), 'utf8')
    assert.equal(readSkillDocument(installed).loadable, true, 'import says success but a different ZIP member replaced the validated document')
  } finally { f.cleanup() }
})

test('R18: NTFS stream aliases must not replace the validated SKILL.md', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture()
  try {
    const archive = makeZip([
      { name: 'SKILL.md', data: doc('demo') },
      { name: 'SKILL.md::$DATA', data: 'stream alias overwrote the main document' },
    ])
    const result = await f.request('POST', endpoint('skill/import'), { rootKey: 'dsh', kind: 'zip', base64: archive.toString('base64') })
    if (!result.ok) return
    const installed = readFileSync(join(f.home, 'skills', 'demo', 'SKILL.md'), 'utf8')
    assert.equal(readSkillDocument(installed).loadable, true, 'NTFS default-stream alias corrupted the validated document')
  } finally { f.cleanup() }
})

test('R19: editing a skill must not follow a document symlink outside its root', async t => {
  const f = fixture()
  try {
    const outside = join(f.dir, 'outside-root', 'target.md')
    const before = doc('linked', 'Outside the skill root')
    put(outside, before)
    const path = join(f.home, 'skills', 'linked', 'SKILL.md')
    mkdirSync(dirname(path), { recursive: true })
    try { symlinkSync(outside, path, 'file') } catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('OS does not allow creating a symlink in this fixture')
      throw error
    }
    const result = await f.request('POST', endpoint('skill/save'), { rootKey: 'dsh', name: 'linked', content: doc('linked', 'Unexpected outside-root write') })
    assert.equal(readFileSync(outside, 'utf8'), before, `outside-root target changed, result.ok=${result.ok}`)
  } finally { f.cleanup() }
})

test('R20: native Cordis-preset skills must not disappear from the manager catalog', async () => {
  const f = fixture()
  const control = new AbortController()
  const presetSkills = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/skills/', import.meta.url))
  const provider = new FileSystemSkillProvider(new Context(), { signal: control.signal, invalidate() {} }, {
    includeDefaultRoots: false, customSkillDirs: [presetSkills], dshHome: f.home, agentsHome: join(f.dir, 'agents'), watch: false,
  })
  try {
    const result = await provider.list({ cwd: f.cwd })
    const native = (Array.isArray(result) ? result : result.candidates).map(item => item.name).sort()
    assert.deepEqual(native, ['cordis-plugin-development', 'editing-cordis-compositions'], 'fixture: installed preset must really supply these two skills')
    const ours = f.runtime.catalogFor(f.cwd)
    assert.deepEqual(compareWithRegistry(ours, native.map(name => ({ name, provider: 'filesystem' }))).extra, [], 'manager never incorporates the preset filesystem custom roots')
  } finally { control.abort(); await provider.dispose(); f.cleanup() }
})

// All these run through the real native provider and real SkillRegistry.get().
// A policy-only override must preserve the chosen definition and its fields.
for (const scenario of [
  {
    title: 'R21: enabling a skill must preserve block-scalar frontmatter and body',
    files: [{ path: 'demo/SKILL.md', text: '---\nname: demo\ndescription: |\n  first\n  ---\n  second\n---\nbody\n' }],
    field: 'content',
    expectedBefore: 'body',
  },
  {
    title: 'R22: enabling a skill must preserve its original metadata',
    files: [{ path: 'demo/SKILL.md', text: doc('demo', 'Metadata fixture', 'metadata:\n  owner: team\n  nested:\n    flag: true\n') }],
    field: 'metadata',
    expectedBefore: { owner: 'team', nested: { flag: true } },
  },
  {
    title: 'R23: enabling a colliding skill must not select a different flat/bundle definition',
    files: [
      { path: 'a-b/SKILL.md', text: '---\nname: demo\ndescription: Bundle\n---\nBUNDLE\n' },
      { path: 'a.md', text: '---\nname: demo\ndescription: Flat\n---\nFLAT\n' },
    ],
    field: 'content',
    expectedBefore: 'BUNDLE',
  },
]) {
  test(scenario.title, async () => {
    const f = fixture(dir => ({ includeDefaultRoots: false, customSkillDirs: [join(dir, 'custom')] }))
    const ctx = new Context()
    const registry = new SkillRegistry(ctx)
    let native
    let stopNative
    let stopOverlay
    try {
      for (const file of scenario.files) put(join(f.dir, 'custom', file.path), file.text)
      stopNative = registry.registerProvider(control => native = new FileSystemSkillProvider(ctx, control, { ...f.settings, watch: false }))
      stopOverlay = registry.registerProvider(control => {
        f.runtime.invalidators.add(control.invalidate)
        return createProvider({ rootsFor: f.runtime.rootsFor, overridesFor: f.runtime.overridesFor })
      })
      const before = await registry.get('demo', { cwd: f.cwd })
      assert.ok(before, 'fixture: native provider must load the original definition')
      assert.deepEqual(before[scenario.field], scenario.expectedBefore, 'fixture: native definition must match the independently stated baseline')
      const rootKey = f.runtime.catalogFor(f.cwd).winners.get('demo').rootKey
      assert.equal(f.runtime.setEnabled({ cwd: f.cwd, rootKey, name: 'demo', enabled: true }).ok, true)
      const after = await registry.get('demo', { cwd: f.cwd })
      assert.ok(after, 'overlay must still load the definition')
      assert.equal(after.provider, 'dsh-skills-manager')
      assert.deepEqual(after[scenario.field], before[scenario.field], `policy-only override changed ${scenario.field}`)
    } finally {
      try {
        stopOverlay?.()
        stopNative?.()
        await native?.dispose()
      } finally {
        f.cleanup()
      }
    }
  })
}

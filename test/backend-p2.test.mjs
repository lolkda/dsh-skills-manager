import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createRuntime } from '../lib/index.js'
import { compareWithRegistry, describeDivergence } from '../lib/divergence.js'
import { createSkill, importFiles } from '../lib/operations.js'
import { createProvider } from '../lib/provider.js'
import { pathIdentity } from '../lib/roots.js'
import { installRoutes } from '../lib/routes.js'
import { installTools } from '../lib/tools.js'
import { saveState, statePath } from '../lib/store.js'
import { call } from './helpers/host-harness.mjs'

const doc = (name, body = 'Body', extra = '') => `---\nname: ${name}\ndescription: Fixture\n${extra}---\n${body}\n`
function put(path, text) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, 'utf8') }
function fixture(configFor = () => ({})) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-backend-p2-'))
  const home = join(dir, 'home'), cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  const settings = { dshHome: home, agentsHome: join(dir, 'agents'), log: false, ...configFor(dir) }
  const runtime = createRuntime(settings)
  runtime.setDefaultCwd(cwd)
  const agents = [], tools = [], cleanups = []
  let route
  const ctx = { get: name => name === 'webRuntime' ? { trustedHosts: [] } : name === 'agents' ? { list: () => agents } : undefined }
  installRoutes(ctx, { register(spec) { route = spec; return () => {} } }, runtime)
  installTools(ctx, { register(spec) { tools.push(spec); return () => {} } }, runtime)
  return {
    dir, home, cwd, settings, runtime, agents,
    root: () => runtime.rootsFor(cwd).find(r => r.key === 'dsh') ?? runtime.rootsFor(cwd)[0],
    async request(method, path, body) {
      const url = new URL(`/dsh-skills-manager${path}`, 'http://test')
      if (!url.searchParams.has('cwd')) url.searchParams.set('cwd', cwd)
      return call(route, method, url.pathname + url.search, body)
    },
    tool: (name, args) => tools.find(tool => tool.name === name).execute({ cwd, ...args }),
    native(overlay = false) {
      const nativeCtx = new Context(), registry = new SkillRegistry(nativeCtx)
      let provider
      const stop = registry.registerProvider(control => provider = new FileSystemSkillProvider(nativeCtx, control, { ...settings, watch: false }))
      cleanups.push(async () => { stop(); await provider.dispose() })
      if (overlay) cleanups.unshift(registry.registerProvider(control => {
        runtime.invalidators.add(control.invalidate)
        return createProvider({ rootsFor: runtime.rootsFor, overridesFor: runtime.overridesFor })
      }))
      runtime.registry = registry
      return { ctx: nativeCtx, registry }
    },
    async cleanup() { try { for (const cleanup of cleanups) await cleanup() } finally { rmSync(dir, { recursive: true, force: true }) } },
  }
}
const query = (path, record, withPath = true) => `${path}?${new URLSearchParams({ rootKey: record.rootKey, name: record.name, ...(withPath ? { docPath: record.docPath } : {}) })}`

test('R03: catalog-issued Chinese/space root keys support writes', async () => {
  const f = fixture()
  try {
    const cwd = join(f.dir, '项目 with space'); mkdirSync(join(cwd, '.git'), { recursive: true })
    const root = (await f.request('GET', `/catalog?cwd=${encodeURIComponent(cwd)}`)).data.roots.find(r => r.source === 'project-dsh')
    const result = await f.request('POST', `/skill/create?cwd=${encodeURIComponent(cwd)}`, { rootKey: root.key, name: 'demo', description: 'valid' })
    assert.equal(result.ok, true, result.error)
    assert.equal(existsSync(join(root.path, 'demo/SKILL.md')), true)
    assert.equal((await f.request('POST', '/skill/create', { rootKey: 'unknown', name: 'bad', description: 'no' })).ok, false)
  } finally { await f.cleanup() }
})
test('R04: broken files remain readable, repairable and deletable; policy requires winner', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'broken/SKILL.md'), '---\nname: broken\n---\nBroken\n')
    const record = f.runtime.catalogFor(f.cwd).skills[0]
    assert.equal(record.winner, false)
    const read = await f.request('GET', query('/skill/content', record))
    assert.equal(read.ok, true, read.error); assert.equal(read.loadable, false); assert.ok(read.diagnostics.length)
    assert.equal((await f.request('POST', '/policy', { rootKey: record.rootKey, name: 'broken', enabled: false })).ok, false)
    assert.equal((await f.request('POST', '/skill/save', { ...record, content: doc('broken') })).ok, true)
    assert.equal(f.runtime.catalogFor(f.cwd).winners.get('broken').loadable, true)
    assert.equal((await f.request('POST', '/skill/delete', record)).ok, true)
    assert.equal(existsSync(record.docPath), false)
  } finally { await f.cleanup() }
})
test('R04: existing tool schemas can manage one unique broken document', async () => {
  const f = fixture()
  try {
    const path = join(f.root().path, 'broken/SKILL.md'); put(path, '---\nname: broken\n---\nBroken\n')
    assert.equal((await f.tool('skills_get', { name: 'broken' })).ok, true)
    assert.equal((await f.tool('skills_update', { name: 'broken', content: doc('broken') })).ok, true)
    put(path, '---\nname: broken\n---\nBroken\n')
    assert.equal((await f.tool('skills_delete', { name: 'broken' })).ok, true)
    assert.equal(existsSync(path), false)
  } finally { await f.cleanup() }
})
test('R04: shadowed entities may be edited, but forged docPath never bypasses catalog', async () => {
  const f = fixture()
  try {
    const high = join(f.cwd, '.dsh/skills/demo/SKILL.md'), low = join(f.root().path, 'demo/SKILL.md')
    put(high, doc('demo', 'PROJECT')); put(low, doc('demo', 'USER'))
    const record = f.runtime.catalogFor(f.cwd).skills.find(s => s.docPath === low)
    assert.equal(record.shadowed, true)
    assert.equal((await f.request('GET', query('/skill/content', record))).ok, true)
    assert.equal((await f.request('POST', '/skill/save', { ...record, content: doc('demo', 'EDIT') })).ok, true)
    assert.equal(readFileSync(high, 'utf8'), doc('demo', 'PROJECT'))
    const outside = join(f.dir, 'outside.md'); put(outside, doc('demo', 'OUTSIDE'))
    assert.equal((await f.request('POST', '/skill/save', { ...record, docPath: outside, content: doc('demo', 'BAD') })).ok, false)
    assert.equal(readFileSync(outside, 'utf8'), doc('demo', 'OUTSIDE'))
    assert.equal((await f.request('GET', query('/skill/content', { ...record, docPath: high }))).ok, false)
  } finally { await f.cleanup() }
})
test('R04: ambiguous names are rejected; deleting a loser preserves the remaining override', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'a/SKILL.md'), doc('demo', 'A')); put(join(f.root().path, 'b/SKILL.md'), doc('demo', 'B'))
    const catalog = f.runtime.catalogFor(f.cwd), winner = catalog.winners.get('demo'), loser = catalog.skills.find(s => !s.winner)
    assert.equal((await f.request('GET', query('/skill/content', winner, false))).code, 'skill.ambiguous')
    assert.equal((await f.tool('skills_update', { name: 'demo', content: doc('demo') })).code, 'skill.ambiguous')
    assert.equal(f.runtime.setEnabled({ rootKey: winner.rootKey, name: 'demo', enabled: false, cwd: f.cwd }).ok, true)
    assert.equal((await f.request('POST', '/skill/delete', loser)).ok, true)
    assert.equal(f.runtime.catalogFor(f.cwd).winners.get('demo').enabled, false)
  } finally { await f.cleanup() }
})
test('R08: registry selects the requested cwd and declines unrelated or unknown agent cwd', async () => {
  const f = fixture()
  try {
    const a = join(f.dir, 'a'), b = join(f.dir, 'b')
    put(join(a, '.dsh/skills/only-a/SKILL.md'), doc('only-a')); put(join(b, '.dsh/skills/only-b/SKILL.md'), doc('only-b'))
    const { ctx } = f.native()
    for (const [id, cwd] of [['a', a], ['b', b]]) f.agents.push({ id, ctx: createScope(ctx, {}).ctx, session: { header: { cwd } } })
    const response = await f.request('GET', `/registry?cwd=${encodeURIComponent(b)}`)
    assert.equal(response.data.divergence.cwd, b); assert.equal(response.data.agentId, 'b')
    assert.ok(response.data.skills.some(s => s.name === 'only-b'))
    assert.equal(response.data.skills.some(s => s.name === 'only-a'), false)
    assert.equal((await f.request('GET', '/registry')).data.divergence.checked, false)
    f.agents.splice(0, f.agents.length, { id: 'unknown', ctx: createScope(ctx, {}).ctx })
    assert.equal((await f.request('GET', '/registry')).data.divergence.checked, false)
  } finally { await f.cleanup() }
})
test('R13: policy mismatches are reported; a legitimate overlay provider change is not', () => {
  const catalog = { skills: [{ name: 'demo', winner: true, loadable: true, source: 'user-dsh', effectiveModelInvocable: false, effectiveUserInvocable: false }] }
  const mismatch = compareWithRegistry(catalog, [{ name: 'demo', source: 'user-dsh', provider: 'filesystem', modelInvocable: true, userInvocable: false }])
  assert.equal(mismatch.consistent, false); assert.deepEqual(mismatch.policyMismatches, ['demo']); assert.equal(mismatch.checkedPolicies, 1)
  assert.match(describeDivergence(mismatch), /策略.*demo/)
  const overlay = compareWithRegistry(catalog, [{ name: 'demo', source: 'user-dsh', provider: 'dsh-skills-manager', invocation: { modelInvocable: false, userInvocable: false } }])
  assert.equal(overlay.consistent, true); assert.deepEqual(overlay.sourceMismatches, [])
})
test('R13: absent fields are not guessed; source conflicts are independently reported', () => {
  const catalog = { skills: [{ name: 'demo', winner: true, source: 'user-dsh' }] }
  const partial = compareWithRegistry(catalog, [{ name: 'demo' }])
  assert.equal(partial.consistent, true); assert.equal(partial.checkedPolicies, 0); assert.deepEqual(partial.policyMismatches, [])
  const source = compareWithRegistry(catalog, [{ name: 'demo', source: 'project-dsh' }])
  assert.equal(source.consistent, false); assert.deepEqual(source.sourceMismatches, ['demo'])
})
test('R14: reordered custom roots retain path-bound policy and configured precedence', async () => {
  const f = fixture(dir => ({ includeDefaultRoots: false, customSkillDirs: [join(dir, 'z'), join(dir, 'a')] }))
  try {
    const [z, a] = f.settings.customSkillDirs
    put(join(z, 'same/SKILL.md'), doc('same')); put(join(a, 'same/SKILL.md'), doc('same')); put(join(z, 'only-z/SKILL.md'), doc('only-z'))
    const before = f.runtime.catalogFor(f.cwd); assert.equal(before.winners.get('same').docPath, join(z, 'same/SKILL.md'))
    const rootKey = before.winners.get('same').rootKey
    for (const name of ['same', 'only-z']) assert.equal(f.runtime.setEnabled({ rootKey, name, enabled: false, cwd: f.cwd }).ok, true)
    assert.equal(f.runtime.catalogFor(f.cwd).winners.get('same').enabled, false)
    const after = createRuntime({ ...f.settings, customSkillDirs: [a, z] }).catalogFor(f.cwd)
    assert.equal(after.winners.get('same').docPath, join(a, 'same/SKILL.md')); assert.equal(after.winners.get('same').override, null)
    assert.equal(after.winners.get('only-z').enabled, false); assert.equal(after.winners.get('only-z').rootKey, rootKey)
    assert.ok(rootKey.includes(pathIdentity(z)))
  } finally { await f.cleanup() }
})
test('R14: legacy custom-N state is retained with diagnostics rather than guessed', async () => {
  const f = fixture(dir => ({ includeDefaultRoots: false, customSkillDirs: [join(dir, 'custom')] }))
  try {
    put(join(f.settings.customSkillDirs[0], 'demo/SKILL.md'), doc('demo'))
    const state = { version: 1, overrides: { 'custom-0': { demo: { enabled: false } } } }; saveState(f.home, state)
    const catalog = createRuntime(f.settings).catalogFor(f.cwd)
    assert.equal(catalog.winners.get('demo').override, null)
    assert.ok(catalog.diagnostics.some(d => d.code === 'override.legacyCustom'))
    assert.deepEqual(JSON.parse(readFileSync(statePath(f.home), 'utf8')), state)
  } finally { await f.cleanup() }
})
for (const kind of ['flat', 'alias-bundle']) for (const operation of ['create', 'import', 'overwrite']) {
  test(`R15: logical collision ${kind}/${operation}`, async () => {
    const f = fixture()
    try {
      const path = kind === 'flat' ? join(f.root().path, 'other.md') : join(f.root().path, 'other/SKILL.md'); put(path, doc('demo', 'ORIGINAL'))
      const result = operation === 'create' ? createSkill({ root: f.root(), name: 'demo', description: 'duplicate' })
        : importFiles({ root: f.root(), overwrite: operation === 'overwrite', files: [{ name: 'SKILL.md', data: Buffer.from(doc('demo', 'NEW')) }] })
      if (operation === 'overwrite') {
        assert.equal(result.ok, true, result.error); assert.equal(existsSync(path), false)
        assert.equal(readFileSync(join(f.root().path, 'demo/SKILL.md'), 'utf8'), doc('demo', 'NEW'))
      } else { assert.equal(result.code, 'skill.exists'); assert.equal(readFileSync(path, 'utf8'), doc('demo', 'ORIGINAL')) }
      assert.equal(f.runtime.catalogFor(f.cwd).skills.length, 1)
    } finally { await f.cleanup() }
  })
}
test('Import overwrite permits an old attachment file to become a directory', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'demo/SKILL.md'), doc('demo')); put(join(f.root().path, 'demo/data'), 'old file')
    const result = importFiles({ root: f.root(), overwrite: true, files: [{ name: 'SKILL.md', data: Buffer.from(doc('demo', 'NEW')) }, { name: 'data/child.txt', data: Buffer.from('new child') }] })
    assert.equal(result.ok, true, result.error); assert.equal(readFileSync(join(f.root().path, 'demo/data/child.txt'), 'utf8'), 'new child')
    assert.equal(readdirSync(f.root().path).some(n => n.startsWith('.dshsm-import-')), false)
  } finally { await f.cleanup() }
})
test('R22: a policy overlay preserves metadata through the real registry.get', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'demo/SKILL.md'), doc('demo', 'BODY', 'metadata:\n  owner: team\n  nested:\n    flag: true\n'))
    const { registry } = f.native(true), before = await registry.get('demo', { cwd: f.cwd })
    assert.deepEqual(before.metadata, { owner: 'team', nested: { flag: true } })
    assert.equal(f.runtime.setEnabled({ rootKey: f.root().key, name: 'demo', enabled: true, cwd: f.cwd }).ok, true)
    const after = await registry.get('demo', { cwd: f.cwd })
    assert.equal(after.provider, 'dsh-skills-manager'); assert.deepEqual(after.metadata, before.metadata); assert.equal(after.content, before.content)
  } finally { await f.cleanup() }
})
test('R23: flat/bundle ties match native filesystem and do not switch on enable', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'a-b/SKILL.md'), doc('demo', 'BUNDLE')); put(join(f.root().path, 'a.md'), doc('demo', 'FLAT'))
    const { registry } = f.native(true), before = await registry.get('demo', { cwd: f.cwd })
    assert.equal(before.content, 'BUNDLE')
    const ours = f.runtime.catalogFor(f.cwd).winners.get('demo'); assert.equal(ours.docPath, before.path)
    assert.equal(f.runtime.setEnabled({ rootKey: ours.rootKey, name: 'demo', enabled: true, cwd: f.cwd }).ok, true)
    assert.equal((await registry.get('demo', { cwd: f.cwd })).content, before.content)
  } finally { await f.cleanup() }
})
test('HTTP saves immediately invalidate the cached overlay catalog', async () => {
  const f = fixture()
  try {
    put(join(f.root().path, 'demo/SKILL.md'), doc('demo'))
    const { registry } = f.native(true)
    assert.equal(f.runtime.setEnabled({ rootKey: f.root().key, name: 'demo', enabled: true, cwd: f.cwd }).ok, true)
    assert.equal((await registry.snapshot({ cwd: f.cwd })).skills.find(s => s.name === 'demo').description, 'Fixture')
    assert.equal((await f.request('POST', '/skill/save', { rootKey: f.root().key, name: 'demo', content: doc('demo').replace('description: Fixture', 'description: Changed') })).ok, true)
    assert.equal((await registry.snapshot({ cwd: f.cwd })).skills.find(s => s.name === 'demo').description, 'Changed')
  } finally { await f.cleanup() }
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import test from 'node:test'

import { RANK, findProjectRoot, listRoots, normalizeRootKey, pathIdentity, scanRoot } from '../lib/roots.js'

test('findProjectRoot 停在最近的 .git 祖先，找不到时退回 cwd', () => {
  const marker = resolve('F:/project/demo')
  const isFile = (path) => pathIdentity(path) === pathIdentity(join(marker, '.git'))
  assert.equal(pathIdentity(findProjectRoot(resolve('F:/project/demo/sub/deep'), isFile)), pathIdentity(marker))
  assert.equal(pathIdentity(findProjectRoot(resolve('F:/nowhere/x/y'), () => false)), pathIdentity(resolve('F:/nowhere/x/y')))
})

test('pathIdentity 归一化分隔符，并按平台处理大小写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-roots-'))
  try {
    const mixed = join(dir, 'Demo', 'Sub')
    // 同一目录的两种写法必须是同一个 key：反斜杠/正斜杠混用与末尾分隔符都不能
    // 产生第二个条目，否则同一处覆盖会时而生效时而失效。
    assert.equal(pathIdentity(`${mixed}${sep}`), pathIdentity(mixed), '末尾分隔符不改变身份')
    assert.equal(pathIdentity(mixed.split(sep).join('/')), pathIdentity(mixed), '正斜杠写法不改变身份')
    const upper = mixed.toUpperCase()
    if (process.platform === 'win32') {
      assert.equal(pathIdentity(upper), pathIdentity(mixed), 'Windows 路径大小写不敏感')
    } else {
      assert.notEqual(pathIdentity(upper), pathIdentity(mixed), 'POSIX 路径大小写敏感')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRoots 按 rank 排序并与 dsh-skill-filesystem 的默认根对齐', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-roots-'))
  try {
    const home = join(dir, 'home', '.dsh')
    const agentsHome = join(dir, 'home', '.agents')
    const bundled = join(dir, 'install', 'bundled-skills')
    const roots = listRoots({
      cwd: join(dir, 'projects', 'deep'),
      env: { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome },
      config: { bundledSkillDir: bundled },
    })
    assert.deepEqual(
      roots.map((r) => [r.source, r.rank]),
      [
        ['project-dsh', RANK.projectDsh],
        ['project-agents', RANK.projectAgents],
        ['user-dsh', RANK.userDsh],
        ['user-agents', RANK.userAgents],
        ['bundled', RANK.bundled],
      ],
    )
    assert.equal(pathIdentity(roots.find((r) => r.source === 'user-dsh').path), pathIdentity(join(home, 'skills')))
    assert.equal(pathIdentity(roots.find((r) => r.source === 'user-agents').path), pathIdentity(join(agentsHome, 'skills')))
    assert.equal(pathIdentity(roots.find((r) => r.source === 'bundled').path), pathIdentity(bundled))
    assert.equal(roots.find((r) => r.source === 'bundled').mutable, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRoots 把 customSkillDirs 排在项目根之后、用户根之前', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-roots-'))
  try {
    const one = join(dir, 'extra', 'one')
    const two = join(dir, 'extra', 'two')
    const roots = listRoots({
      cwd: join(dir, 'projects'),
      env: { DSH_HOME: join(dir, 'home', '.dsh'), DSH_AGENTS_HOME: join(dir, 'home', '.agents') },
      config: { customSkillDirs: [one, two, ''] },
    })
    const custom = roots.filter((r) => r.source === 'custom')
    assert.deepEqual(custom.map((r) => pathIdentity(r.path)), [pathIdentity(one), pathIdentity(two)])
    assert.ok(custom[0].rank > RANK.projectAgents && custom[0].rank < RANK.userDsh)
    assert.equal(custom[0].key, `custom@${pathIdentity(one)}`)
    assert.equal(custom[1].key, `custom@${pathIdentity(two)}`)
    assert.deepEqual(custom.map((root) => root.rank), [RANK.custom, RANK.custom])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRoots 的 includeDefaultRoots=false 只剩自定义根', () => {
  const roots = listRoots({
    cwd: 'F:/nowhere',
    env: { DSH_HOME: 'F:/home/.dsh' },
    config: { includeDefaultRoots: false, customSkillDirs: ['F:/extra'] },
  })
  assert.deepEqual(roots.map((r) => r.source), ['custom'])
})

test('项目根的 key 编入项目路径，使两个项目互不干扰', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-roots-'))
  try {
    const home = join(dir, 'home', '.dsh')
    const env = { DSH_HOME: home }
    const a = listRoots({ cwd: join(dir, 'proj-a', 'x'), env, config: {} }).find((r) => r.source === 'project-dsh')
    const b = listRoots({ cwd: join(dir, 'proj-b', 'x'), env, config: {} }).find((r) => r.source === 'project-dsh')
    assert.notEqual(a.key, b.key)
    assert.match(a.key, /^project-dsh@/)
    assert.equal(a.key, `project-dsh@${pathIdentity(join(dir, 'proj-a', 'x'))}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanRoot 只识别一层，并跳过隐藏项与非 markdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-'))
  try {
    mkdirSync(join(dir, 'bundle-skill'))
    writeFileSync(join(dir, 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: x\n---\n')
    writeFileSync(join(dir, 'flat-skill.md'), '---\nname: flat-skill\ndescription: x\n---\n')
    writeFileSync(join(dir, 'notes.txt'), 'not a skill')
    mkdirSync(join(dir, '.system'))
    writeFileSync(join(dir, '.system', 'hidden.md'), '---\nname: hidden\ndescription: x\n---\n')
    mkdirSync(join(dir, 'nested', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'nested', 'deep', 'SKILL.md'), '---\nname: deep\ndescription: x\n---\n')

    const root = { key: 'dsh', source: 'user-dsh', rank: RANK.userDsh, path: dir, scope: 'user', mutable: true, exists: true }
    const { entries, diagnostics } = scanRoot(root)
    assert.deepEqual(entries.map((e) => [e.entryName, e.kind]), [
      ['bundle-skill', 'bundle'],
      ['flat-skill', 'flat'],
    ])
    assert.deepEqual(diagnostics, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanRoot 对不存在的根返回空而不是抛错', () => {
  const root = { key: 'dsh', path: join(tmpdir(), 'dshsm-does-not-exist'), exists: false }
  assert.deepEqual(scanRoot(root), { entries: [], diagnostics: [] })
})

test('normalizeRootKey 只接受已知形状，用于校验外部输入', () => {
  assert.equal(normalizeRootKey('dsh'), 'dsh')
  assert.equal(normalizeRootKey('custom-0'), 'custom-0')
  assert.equal(normalizeRootKey('  ') , '')
  assert.equal(normalizeRootKey(42), '')
})

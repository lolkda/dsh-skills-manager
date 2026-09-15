import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildCatalog, overridesOf } from '../lib/catalog.js'
import { RANK } from '../lib/roots.js'

/**
 * 造一个磁盘布局：低 rank 的项目根里有一个与高 rank 用户根同名的技能。
 * @returns {{ dir: string, project: object, user: object, cleanup: () => void }}
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-catalog-'))
  const projectPath = join(dir, 'project-skills')
  const userPath = join(dir, 'user-skills')
  mkdirSync(join(projectPath, 'alpha'), { recursive: true })
  mkdirSync(join(userPath, 'alpha'), { recursive: true })
  mkdirSync(join(userPath, 'beta'), { recursive: true })
  writeFileSync(join(projectPath, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 项目版 alpha\n---\n项目正文\n')
  writeFileSync(join(userPath, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 用户版 alpha\n---\n用户正文\n')
  writeFileSync(join(userPath, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: 用户版 beta\ndisable-model-invocation: true\n---\n正文\n')
  writeFileSync(join(userPath, 'broken.md'), '没有 frontmatter\n')
  return {
    dir,
    project: { key: 'project-dsh@x', source: 'project-dsh', rank: RANK.projectDsh, path: projectPath, scope: 'project', mutable: true, exists: true },
    user: { key: 'dsh', source: 'user-dsh', rank: RANK.userDsh, path: userPath, scope: 'user', mutable: true, exists: true },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('buildCatalog 按 rank 裁决重名，并保留被遮蔽项', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user, f.project], overrides: {} })
    const alpha = catalog.winners.get('alpha')
    assert.equal(alpha.rootKey, 'project-dsh@x', '低 rank 的项目根胜出')
    assert.equal(alpha.description, '项目版 alpha')

    const allAlpha = catalog.skills.filter((s) => s.name === 'alpha')
    assert.equal(allAlpha.length, 2)
    assert.equal(allAlpha.filter((s) => s.shadowed).length, 1)

    const beta = catalog.winners.get('beta')
    assert.equal(beta.fileModelInvocable, false, 'disable-model-invocation 让文件级策略为不可被模型调用')
    assert.equal(beta.enabled, false, '未覆盖时沿用文件策略')
    assert.equal(beta.override, null)
  } finally {
    f.cleanup()
  }
})

test('buildCatalog 对坏文件仍列出并给出诊断', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user], overrides: {} })
    const broken = catalog.skills.find((s) => s.entryName === 'broken')
    assert.ok(broken, '坏文件必须出现，否则用户无法在界面里修它')
    assert.equal(broken.loadable, false)
    assert.ok(broken.diagnostics.some((d) => d.code === 'frontmatter.missing'))
    assert.ok(catalog.diagnostics.some((d) => d.skill === 'broken'))
  } finally {
    f.cleanup()
  }
})

test('覆盖施加在胜出根上，且不会被文件策略覆盖', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user, f.project], overrides: { dsh: { beta: { enabled: true } } } })
    const beta = catalog.winners.get('beta')
    assert.equal(beta.override, true)
    assert.equal(beta.effectiveModelInvocable, true, '显式启用必须翻转文件里的 disable-model-invocation')
    assert.equal(beta.enabled, true)
  } finally {
    f.cleanup()
  }
})

test('对被遮蔽的根设置覆盖时不生效，并明确报出原因', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user, f.project], overrides: { dsh: { alpha: { enabled: false } } } })
    const alpha = catalog.winners.get('alpha')
    assert.equal(alpha.rootKey, 'project-dsh@x')
    assert.equal(alpha.effectiveModelInvocable, true, '覆盖落在被遮蔽的根上，不应改变胜出者')

    const shadowed = catalog.skills.find((s) => s.name === 'alpha' && s.rootKey === 'dsh')
    assert.equal(shadowed.overrideShadowed, true)
    assert.ok(
      catalog.diagnostics.some((d) => d.code === 'override.shadowed' && d.rootKey === 'dsh'),
      '必须报出「你设置的覆盖没生效」而不是让用户以为停用成功了',
    )
  } finally {
    f.cleanup()
  }
})

test('overridesOf 只返回需要注册表覆盖的胜出技能', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user, f.project], overrides: { dsh: { beta: { enabled: true } } } })
    const overrides = overridesOf(catalog)
    assert.deepEqual(overrides.map((s) => s.name), ['beta'])
  } finally {
    f.cleanup()
  }
})

test('文件不可读时记录 loadable=false 而不是抛错', () => {
  const f = fixture()
  try {
    const catalog = buildCatalog({ roots: [f.user], overrides: {}, readFile: () => undefined })
    assert.ok(catalog.skills.length > 0)
    for (const skill of catalog.skills) {
      assert.equal(skill.loadable, false)
      assert.ok(skill.diagnostics.some((d) => d.code === 'skill.unreadable'))
    }
  } finally {
    f.cleanup()
  }
})

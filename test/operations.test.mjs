import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createSkill,
  importFiles,
  listTrash,
  moveToTrash,
  purgeFromTrash,
  restoreFromTrash,
  within,
  writeSkillContent,
} from '../lib/operations.js'
import { RANK } from '../lib/roots.js'

/**
 * 搭一个临时环境。
 * @returns {{ dshHome: string, root: object, cleanup: () => void }}
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-ops-'))
  const rootPath = join(dir, 'skills')
  mkdirSync(rootPath, { recursive: true })
  return {
    dshHome: join(dir, '.dsh'),
    root: { key: 'dsh', source: 'user-dsh', rank: RANK.userDsh, path: rootPath, scope: 'user', mutable: true, exists: true },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('within 只接受根目录内部的严格子孙路径', () => {
  const root = 'F:/a/skills'
  assert.equal(within(root, 'F:/a/skills/demo/SKILL.md'), true)
  assert.equal(within(root, 'F:/a/skills'), false, '根目录自身不是合法目标')
  assert.equal(within(root, 'F:/a/skills-other/x.md'), false, '前缀相同但不是子目录')
  assert.equal(within(root, 'F:/a/other/x.md'), false)
})

test('createSkill 规范化名字并落成 bundle 形态', () => {
  const f = fixture()
  try {
    const result = createSkill({ root: f.root, name: 'My New Skill', description: '一个演示技能', body: '正文\n' })
    assert.equal(result.ok, true, result.ok ? '' : result.error)
    assert.equal(result.name, 'my-new-skill')
    const text = readFileSync(join(f.root.path, 'my-new-skill', 'SKILL.md'), 'utf8')
    assert.match(text, /name: my-new-skill/)
    assert.match(text, /description: "一个演示技能"/)

    const again = createSkill({ root: f.root, name: 'my new skill', description: 'x' })
    assert.equal(again.ok, false)
    assert.equal(again.code, 'skill.exists')
  } finally {
    f.cleanup()
  }
})

test('createSkill 拒绝只读根与空描述', () => {
  const f = fixture()
  try {
    assert.equal(createSkill({ root: { ...f.root, mutable: false }, name: 'x', description: 'y' }).code, 'root.readOnly')
    assert.equal(createSkill({ root: f.root, name: 'x', description: '   ' }).code, 'description.missing')
    assert.equal(createSkill({ root: f.root, name: '中文', description: 'y' }).code, 'name.invalid')
  } finally {
    f.cleanup()
  }
})

test('writeSkillContent 拒绝会把技能弄坏的内容', () => {
  const f = fixture()
  try {
    const created = createSkill({ root: f.root, name: 'demo', description: 'x' })
    assert.equal(created.ok, true)
    const docPath = created.path

    const broken = writeSkillContent({ docPath, rootPath: f.root.path, content: '没有 frontmatter' })
    assert.equal(broken.ok, false)
    assert.equal(broken.code, 'document.invalid')
    assert.ok(broken.diagnostics.length > 0)
    assert.match(readFileSync(docPath, 'utf8'), /name: demo/, '被拒绝的保存不能改动原文件')

    const ok = writeSkillContent({
      docPath,
      rootPath: f.root.path,
      content: '---\nname: demo\ndescription: 改过的描述\n---\n新正文\n',
    })
    assert.equal(ok.ok, true, ok.ok ? '' : ok.error)
    assert.match(readFileSync(docPath, 'utf8'), /新正文/)
  } finally {
    f.cleanup()
  }
})

test('回收站：移入、列出、恢复、永久删除', () => {
  const f = fixture()
  try {
    const created = createSkill({ root: f.root, name: 'demo', description: 'x' })
    const skill = { name: 'demo', entryName: 'demo', kind: 'bundle', docPath: created.path }

    const trashed = moveToTrash({ dshHome: f.dshHome, root: f.root, skill })
    assert.equal(trashed.ok, true, trashed.ok ? '' : trashed.error)
    assert.equal(existsSync(join(f.root.path, 'demo')), false, '原位置必须已经空了')

    const items = listTrash(f.dshHome)
    assert.equal(items.length, 1)
    assert.equal(items[0].name, 'demo')
    assert.equal(items[0].rootKey, 'dsh')

    const restored = restoreFromTrash({ dshHome: f.dshHome, id: trashed.id, roots: [f.root] })
    assert.equal(restored.ok, true, restored.ok ? '' : restored.error)
    assert.equal(existsSync(join(f.root.path, 'demo', 'SKILL.md')), true)
    assert.equal(listTrash(f.dshHome).length, 0, '恢复后回收站条目应被清掉')

    const again = moveToTrash({ dshHome: f.dshHome, root: f.root, skill })
    const purged = purgeFromTrash({ dshHome: f.dshHome, id: again.id })
    assert.equal(purged.ok, true)
    assert.equal(listTrash(f.dshHome).length, 0)
  } finally {
    f.cleanup()
  }
})

test('恢复时不覆盖已存在的同名技能', () => {
  const f = fixture()
  try {
    const created = createSkill({ root: f.root, name: 'demo', description: 'x' })
    const trashed = moveToTrash({
      dshHome: f.dshHome,
      root: f.root,
      skill: { name: 'demo', entryName: 'demo', kind: 'bundle', docPath: created.path },
    })
    createSkill({ root: f.root, name: 'demo', description: '重新建的' })
    const restored = restoreFromTrash({ dshHome: f.dshHome, id: trashed.id, roots: [f.root] })
    assert.equal(restored.ok, false)
    assert.equal(restored.code, 'skill.exists')
  } finally {
    f.cleanup()
  }
})

test('importFiles 从任意层级的技能目录导入并统一成 SKILL.md', () => {
  const f = fixture()
  try {
    const result = importFiles({
      root: f.root,
      files: [
        { name: 'my-skill/SKILL.md', data: Buffer.from('---\nname: imported\ndescription: 导入的技能\n---\n正文\n') },
        { name: 'my-skill/references/notes.md', data: Buffer.from('参考') },
        { name: 'my-skill/README.md', data: Buffer.from('说明') },
      ],
    })
    assert.equal(result.ok, true, result.ok ? '' : result.error)
    assert.equal(result.name, 'imported')
    assert.equal(readFileSync(join(f.root.path, 'imported', 'references', 'notes.md'), 'utf8'), '参考')
    assert.equal(readFileSync(join(f.root.path, 'imported', 'README.md'), 'utf8'), '说明')
  } finally {
    f.cleanup()
  }
})

test('importFiles 平铺 Markdown 也落成 bundle', () => {
  const f = fixture()
  try {
    const result = importFiles({
      root: f.root,
      files: [{ name: 'some-skill.md', data: Buffer.from('---\nname: flat-import\ndescription: x\n---\n正文\n') }],
    })
    assert.equal(result.ok, true, result.ok ? '' : result.error)
    assert.equal(existsSync(join(f.root.path, 'flat-import', 'SKILL.md')), true)
  } finally {
    f.cleanup()
  }
})

test('importFiles 拒绝没有文档、文档损坏与越界条目', () => {
  const f = fixture()
  try {
    assert.equal(importFiles({ root: f.root, files: [{ name: 'a.txt', data: Buffer.from('x') }] }).code, 'import.noDocument')
    assert.equal(
      importFiles({ root: f.root, files: [{ name: 'SKILL.md', data: Buffer.from('坏的') }] }).code,
      'document.invalid',
    )
    const escaped = importFiles({
      root: f.root,
      files: [{ name: 'SKILL.md', data: Buffer.from('---\nname: ok\ndescription: x\n---\n') }],
    })
    assert.equal(escaped.ok, true)
    assert.equal(existsSync(join(f.root.path, 'ok', 'SKILL.md')), true)
  } finally {
    f.cleanup()
  }
})

test('导入同名技能默认拒绝，overwrite 才覆盖', () => {
  const f = fixture()
  try {
    const files = [{ name: 'SKILL.md', data: Buffer.from('---\nname: dup\ndescription: x\n---\n') }]
    assert.equal(importFiles({ root: f.root, files }).ok, true)
    const second = importFiles({ root: f.root, files })
    assert.equal(second.code, 'skill.exists')
    assert.equal(importFiles({ root: f.root, files, overwrite: true }).ok, true)
  } finally {
    f.cleanup()
  }
})

test('保存到根目录之外的目标被拒绝', () => {
  const f = fixture()
  try {
    const outside = join(f.dshHome, 'outside.md')
    mkdirSync(f.dshHome, { recursive: true })
    writeFileSync(outside, 'x')
    const result = writeSkillContent({ docPath: outside, rootPath: f.root.path, content: '---\nname: a\ndescription: b\n---\n' })
    assert.equal(result.code, 'path.escape')
  } finally {
    f.cleanup()
  }
})

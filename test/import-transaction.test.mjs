import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { importFiles } from '../lib/operations.js'

// Only the publish/restore rename syscall is fault-injected; all bytes and
// directory moves otherwise use the real temporary filesystem.
for (const failRollback of [false, true]) {
  test(`覆盖导入提交失败：${failRollback ? '恢复失败时保留恢复路径' : '恢复成功时还原整个旧包'}`, t => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'dshsm-transaction-'))
    const root = { key: 'test', path: join(dir, 'skills'), mutable: true, source: 'custom' }
    const target = join(root.path, 'demo')
    fs.mkdirSync(target, { recursive: true })
    const old = '---\nname: demo\ndescription: Original\n---\nOld body\n'
    const replacement = '---\nname: demo\ndescription: Replacement\n---\nNew body\n'
    fs.writeFileSync(join(target, 'SKILL.md'), old)
    fs.writeFileSync(join(target, 'keep.txt'), 'original attachment')
    const realRename = fs.renameSync
    let attemptsToPublish = 0
    t.mock.method(fs, 'renameSync', (from, to) => {
      if (resolve(to) === resolve(target)) {
        attemptsToPublish++
        if (attemptsToPublish === 1 || failRollback) {
          throw Object.assign(new Error('injected publish/restore failure'), { code: 'EPERM' })
        }
      }
      return realRename(from, to)
    })
    syncBuiltinESMExports()
    try {
      const result = importFiles({ root, overwrite: true, files: [{ name: 'SKILL.md', data: Buffer.from(replacement) }] })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'import.writeFailed')
      assert.equal(attemptsToPublish, 2, 'must attempt to restore after failed publish')
      const surviving = failRollback ? result.recoveryPath : target
      assert.equal(typeof surviving, 'string')
      assert.equal(fs.readFileSync(join(surviving, 'SKILL.md'), 'utf8'), old)
      assert.equal(fs.readFileSync(join(surviving, 'keep.txt'), 'utf8'), 'original attachment')
      if (!failRollback) {
        assert.equal(result.recoveryPath, undefined)
        assert.deepEqual(fs.readdirSync(root.path), ['demo'], 'successful recovery cleans staging')
      } else {
        assert.equal(fs.existsSync(target), false)
        assert.match(result.error, /恢复失败|自动恢复失败/)
      }
    } finally {
      t.mock.restoreAll()
      syncBuiltinESMExports()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
}

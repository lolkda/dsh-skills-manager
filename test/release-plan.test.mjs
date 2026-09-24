/**
 * 发布计划（版本 → git tag / npm dist-tag）的判定测试。
 *
 * 为什么要有这层：发布是**不可逆**动作。npm 上 `latest` 只能指向一个版本，预发布版一旦
 * 被推到 `latest`，所有 `npm install` 的用户都会拿到 rc 版；而 tag 与 package.json 版本
 * 不一致时推上去，产物名和仓库标签对不上，事后只能删 tag。所以这两条判定必须在真正
 * `npm publish` 之前、在 CI 里就跑过一次，并且能单独测。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { planRelease } from '../scripts/release-plan.mjs'

const script = fileURLToPath(new URL('../scripts/release-plan.mjs', import.meta.url))

test('正式版本走 latest，预发布版本走 next', () => {
  const stable = planRelease({ version: '0.2.2' })
  assert.equal(stable.ok, true, stable.ok ? '' : stable.error)
  assert.equal(stable.plan.distTag, 'latest')
  assert.equal(stable.plan.tag, 'v0.2.2')
  assert.equal(stable.plan.prerelease, false)

  const prerelease = planRelease({ version: '0.2.2-rc.1', ref: 'refs/tags/v0.2.2-rc.1' })
  assert.equal(prerelease.ok, true, prerelease.ok ? '' : prerelease.error)
  assert.equal(prerelease.plan.distTag, 'next')
  assert.equal(prerelease.plan.tag, 'v0.2.2-rc.1')
  assert.equal(prerelease.plan.prerelease, true)
})

test('不带 ref 时（手动触发）只算 dist-tag，不校验 tag', () => {
  const result = planRelease({ version: '0.2.2-rc.1', ref: '' })
  assert.equal(result.ok, true, result.ok ? '' : result.error)
  assert.equal(result.plan.tag, 'v0.2.2-rc.1')
  assert.equal(result.plan.distTag, 'next')
})

test('tag 与 package.json 版本不一致时拒绝发布，并同时报出两者', () => {
  const result = planRelease({ version: '0.2.2', ref: 'refs/tags/v0.2.3' })
  assert.equal(result.ok, false)
  assert.match(result.error, /v0\.2\.3/)
  assert.match(result.error, /0\.2\.2/)
})

test('分支或非 tag 的 ref 一律拒绝', () => {
  for (const bad of ['refs/heads/main', 'main', 'refs/pull/7/merge']) {
    const result = planRelease({ version: '0.2.2', ref: bad })
    assert.equal(result.ok, false, `${bad} 不该被当作 tag`)
    assert.match(result.error, /tag/)
  }
})

test('不合法版本号被拒绝', () => {
  for (const bad of [undefined, null, '', 'v0.2.2', '0.2', '0.2.2.1', 'latest', '0.2.2 rc1']) {
    const result = planRelease({ version: bad })
    assert.equal(result.ok, false, `${String(bad)} 不该通过`)
    assert.match(result.error, /版本号/)
  }
})

test('CLI 把版本与 dist-tag 写进 GITHUB_OUTPUT，stdout 仍是可读 JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-plan-'))
  try {
    const output = join(dir, 'github-output.txt')
    writeFileSync(output, '')
    const run = spawnSync(
      process.execPath,
      [script, '--version', '0.2.2-rc.1', '--ref', 'refs/tags/v0.2.2-rc.1'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } },
    )
    assert.equal(run.status, 0, run.stderr)
    assert.equal(JSON.parse(run.stdout).distTag, 'next')
    assert.equal(
      readFileSync(output, 'utf8'),
      'version=0.2.2-rc.1\ntag=v0.2.2-rc.1\ndist_tag=next\nprerelease=true\n',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI 在 tag 不匹配时非零退出，且不往 GITHUB_OUTPUT 里写半截结果', () => {
  const dir = mkdtempSync(join(tmpdir(), 'release-plan-'))
  try {
    const output = join(dir, 'github-output.txt')
    writeFileSync(output, '')
    const run = spawnSync(
      process.execPath,
      [script, '--version', '0.2.2', '--ref', 'refs/tags/v0.2.1'],
      { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output } },
    )
    assert.equal(run.status, 1)
    assert.match(run.stderr, /v0\.2\.1/)
    assert.equal(readFileSync(output, 'utf8'), '')
    assert.match(run.stdout, /"ok":\s*false/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
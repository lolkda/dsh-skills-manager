/**
 * 对**真实注册表**的集成测试。
 *
 * 这里挂的是 `@deepseek-ai/dsh-skill` 与 `@deepseek-ai/dsh-skill-filesystem` 本身，
 * 不是替身。本插件最关键的主张 —— 「不改源文件就能改变某个 skill 的调用策略」 ——
 * 只有在真实裁决逻辑下成立才算数，用假注册表测等于什么都没测。
 *
 * 判据取自 `ctx.skills.snapshot()`：谁赢了、赢得了什么策略。这与模型最终看到的
 * 会话目录同源。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { PROVIDER_NAME, createProvider } from '../lib/provider.js'
import { listRoots } from '../lib/roots.js'

/**
 * 搭一套临时环境并在真实注册表上启动本提供方。
 * @param {object} [overrides] - 初始覆盖表
 * @returns {Promise<object>} 上下文、查找函数与清理函数
 */
async function boot(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-registry-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'plain'), { recursive: true })
  mkdirSync(join(home, 'skills', 'locked'), { recursive: true })
  writeFileSync(
    join(home, 'skills', 'plain', 'SKILL.md'),
    '---\nname: plain\ndescription: 一个普通技能\n---\n普通正文\n',
  )
  writeFileSync(
    join(home, 'skills', 'locked', 'SKILL.md'),
    '---\nname: locked\ndescription: 文件自己声明不可被模型调用\ndisable-model-invocation: true\n---\n锁定正文\n',
  )

  const env = { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome }
  const config = { dshHome: home, agentsHome, includeDefaultRoots: true, watch: false }
  const rootsFor = (lookupCwd) => listRoots({ cwd: lookupCwd ?? cwd, env, config })

  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  ctx.plugin({
    name: 'test-skills-manager-overlay',
    inject: ['skills'],
    apply(inner) {
      inner.skills.registerProvider(() => createProvider({ rootsFor, overridesFor: () => overrides }))
    },
  })
  await settle(ctx)
  return { ctx, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 等到注册表能给出完整快照。
 * @param {object} ctx - cordis 上下文
 * @returns {Promise<void>} 结算完成
 */
async function settle(ctx) {
  for (let i = 0; i < 60; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (ctx.skills) return
  }
}

test('无覆盖时，文件系统提供方的原始策略被如实反映', async () => {
  const { ctx, cleanup } = await boot({})
  try {
    const snap = await ctx.skills.snapshot({ cwd: process.cwd() })
    const plain = snap.skills.find((s) => s.name === 'plain')
    const locked = snap.skills.find((s) => s.name === 'locked')
    assert.equal(plain.invocation.modelInvocable, true)
    assert.equal(plain.provider, 'filesystem')
    assert.equal(locked.invocation.modelInvocable, false, '文件里的 disable-model-invocation 生效')
    assert.equal(locked.provider, 'filesystem')
  } finally {
    cleanup()
  }
})

test('停用覆盖压过文件级策略，且源文件保持不变', async () => {
  const { ctx, cleanup } = await boot({ dsh: { plain: { enabled: false } } })
  try {
    const snap = await ctx.skills.snapshot({ cwd: process.cwd() })
    const plain = snap.skills.find((s) => s.name === 'plain')
    assert.equal(plain.invocation.modelInvocable, false, '覆盖后模型不可再调用它')
    assert.equal(plain.invocation.userInvocable, false)
    assert.equal(plain.provider, PROVIDER_NAME, '胜出的必须是本插件发出的候选')
  } finally {
    cleanup()
  }
})

test('启用覆盖能翻转文件里的 disable-model-invocation，且正文仍可加载', async () => {
  const { ctx, cleanup } = await boot({ dsh: { locked: { enabled: true } } })
  try {
    const snap = await ctx.skills.snapshot({ cwd: process.cwd() })
    const locked = snap.skills.find((s) => s.name === 'locked')
    assert.equal(locked.invocation.modelInvocable, true, '显式启用必须覆盖文件声明')
    assert.equal(locked.provider, PROVIDER_NAME)

    const definition = await ctx.skills.get('locked', { cwd: process.cwd() })
    assert.ok(definition, '赢了裁决却拿不到正文，等于把技能弄坏了')
    assert.equal(definition.content.trim(), '锁定正文')
    assert.equal(definition.name, 'locked')
  } finally {
    cleanup()
  }
})

test('未覆盖的技能不受影响，仍由文件系统提供方服务', async () => {
  const { ctx, cleanup } = await boot({ dsh: { plain: { enabled: false } } })
  try {
    const definition = await ctx.skills.get('locked', { cwd: process.cwd() })
    assert.ok(definition)
    assert.equal(definition.provider, 'filesystem')
  } finally {
    cleanup()
  }
})

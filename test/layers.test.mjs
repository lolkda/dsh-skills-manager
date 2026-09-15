/**
 * 分层遮蔽测试：证明「只在宿主层注册覆盖提供方会被 preset 层压掉」。
 *
 * 这是本插件唯一一处无法靠读代码确信的行为，也是参考实现疑似失效的最可能原因。
 * `standard` preset 会**再挂一次** `dsh-skill-filesystem`，注册进 preset 自己的层；
 * 注册表读取时「最近层直接赢得重名」，rank 只在同层内比较。于是：
 *
 *   宿主层覆盖（rank 0）  vs  preset 层文件系统（rank 400）  →  preset 层赢
 *
 * 本测试用 `@deepseek-ai/dsh-scope` 的 `createScope` 复现这两层，把结论钉死。
 * 因此 `lib/index.js` 里的 `installAgentProviders` 不是保险措施，而是必需品。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { createProvider } from '../lib/provider.js'
import { listRoots } from '../lib/roots.js'

/**
 * 搭出一个宿主层 + 一个 preset 层的组合。
 * @returns {Promise<object>} 环境
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-layers-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'plain'), { recursive: true })
  writeFileSync(join(home, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: 普通技能\n---\n正文\n')

  const env = { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome }
  const config = { dshHome: home, agentsHome, includeDefaultRoots: true, watch: false }
  const rootsFor = (lookup) => listRoots({ cwd: lookup ?? cwd, env, config })
  const overrides = { dsh: { plain: { enabled: false } } }

  /**
   * 把我们的覆盖提供方挂到给定上下文上。
   * @param {object} target - 要挂载的上下文
   * @returns {void}
   */
  const mountOverlay = (target) =>
    target.plugin({
      name: `overlay-${Math.random().toString(36).slice(2)}`,
      inject: ['skills'],
      apply(inner) {
        inner.skills.registerProvider(() => createProvider({ rootsFor, overridesFor: () => overrides }))
      },
    })

  const root = new Context()
  root.plugin(SkillRegistry, {})
  const key = {}
  const scope = createScope(root, key)
  await settle(root)
  // preset 层：文件系统提供方注册进这一层，就像 standard preset 做的那样。
  scope.ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  await settle(root)

  return { root, key, scope, mountOverlay, cwd, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/**
 * 等注册表可用。
 * @param {object} ctx - 上下文
 * @returns {Promise<void>} 完成
 */
async function settle(ctx) {
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    if (ctx.skills) return
  }
}

/**
 * 取某个技能在给定查看 scope 下的最终策略。
 * @param {object} env - 环境
 * @returns {Promise<object>} 快照里的 plain
 */
async function plainIn(env) {
  const snapshot = await env.root.skills.snapshot({ cwd: env.cwd, scope: env.key })
  return snapshot.skills.find((skill) => skill.name === 'plain')
}

test('只在宿主层注册覆盖，会被 preset 层的文件系统提供方压掉', async () => {
  const env = await boot()
  try {
    const baseline = await plainIn(env)
    assert.equal(baseline.provider, 'filesystem', 'preset 层的文件系统提供方是这个技能的实际来源')

    env.mountOverlay(env.root)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const afterHostOnly = await plainIn(env)
    assert.equal(afterHostOnly.provider, 'filesystem', '宿主层的覆盖候选赢不了更近的层')
    assert.equal(afterHostOnly.invocation.modelInvocable, true, '因此停用没有生效 —— 这正是要避免的失败')
  } finally {
    env.cleanup()
  }
})

test('同一层里注册覆盖，rank 0 才能赢下裁决', async () => {
  const env = await boot()
  try {
    env.mountOverlay(env.root)
    env.mountOverlay(env.scope.ctx)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const after = await plainIn(env)
    assert.equal(after.provider, 'dsh-skills-manager', '同层内 rank 0 小于文件系统的 400，覆盖胜出')
    assert.equal(after.invocation.modelInvocable, false)
    assert.equal(after.invocation.userInvocable, false)
  } finally {
    env.cleanup()
  }
})

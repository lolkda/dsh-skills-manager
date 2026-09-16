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
 * @param {object} [options] - 参数
 * @param {string[]} [options.frontmatter] - 追加到 plain 的 frontmatter 行
 * @returns {Promise<object>} 环境
 */
async function boot(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-layers-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'plain'), { recursive: true })
  writeFileSync(
    join(home, 'skills', 'plain', 'SKILL.md'),
    ['---', 'name: plain', 'description: 普通技能', ...(options.frontmatter ?? []), '---', '正文', ''].join('\n'),
  )

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

test('覆盖胜出之后，技能的其它性质一个都不能变', async () => {
  // 这是"启停只该改变调用策略"的守门测试。
  //
  // 覆盖提供方的候选会**整条**取代文件系统的候选（同层 rank 0 胜出），所以它必须把技能原有的
  // 字段一并带过来。曾经漏掉了 `whenToUse`：一条技能只要被启停过一次，它的 whenToUse 就会对
  // 所有下游消费者消失 —— 界面看不出来，注册表也不报错，只是那条信息没了。
  const env = await boot({ frontmatter: ['whenToUse: 当需要验证覆盖保真度时使用'] })
  try {
    const baseline = await plainIn(env)
    assert.equal(baseline.provider, 'filesystem')
    assert.equal(baseline.whenToUse, '当需要验证覆盖保真度时使用', '前提：文件系统提供方确实带出了 whenToUse')

    env.mountOverlay(env.root)
    env.mountOverlay(env.scope.ctx)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const after = await plainIn(env)

    assert.equal(after.provider, 'dsh-skills-manager', '前提：覆盖确实赢了')
    assert.equal(after.invocation.modelInvocable, false, '策略确实变了')
    assert.equal(after.whenToUse, baseline.whenToUse, 'whenToUse 必须原样带过来')
    assert.equal(after.description, baseline.description, 'description 必须原样带过来')
    assert.equal(after.userInvocable, baseline.userInvocable, '其它调用位不该被牵连')
    // 本插件**不往候选里写 metadata**：那是整份替换而不是合并，写了会连带丢掉技能自己
    // frontmatter 里的 metadata（本插件的解析器刻意不解析嵌套映射，复现不了）。
    assert.equal(after.metadata?.dshSkillsManager, undefined, '不再往 metadata 里塞自己的标记')
  } finally {
    env.cleanup()
  }
})

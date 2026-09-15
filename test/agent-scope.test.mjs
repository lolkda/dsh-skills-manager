/**
 * agent 作用域端到端测试：走**插件自己的 `apply()`**，验证一个会话真正看到什么。
 *
 * `layers.test.mjs` 证明的是「同层 rank 0 胜过 preset 层」（一条原理）。这里再往前一步，
 * 把原理和实现接起来：真实 cordis 上下文 + 真实 `dsh-scope` + 真实 `dsh-skill` + 真实
 * `dsh-skill-filesystem`，preset 层挂在一个 scope 上（就像 `standard` preset 做的那样），
 * 然后触发 `agent/created`，看那个 agent 的上下文里注册表解析出什么。
 *
 * 这是在不启动真实会话的前提下，能做到的最接近真机的验证：被验证的是
 * `lib/index.js` 里 `installAgentProviders` 的真实代码路径，而不是它的复述。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { apply, runtimeOf } from '../lib/index.js'
import { scopeKeyOf } from '../lib/scope.js'

/**
 * 搭出一个「宿主 + preset 层」的组合，并在 preset 层挂上文件系统提供方。
 * @returns {Promise<object>} 环境
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-agent-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'kept'), { recursive: true })
  mkdirSync(join(home, 'skills', 'dropped'), { recursive: true })
  writeFileSync(join(home, 'skills', 'kept', 'SKILL.md'), '---\nname: kept\ndescription: 保留的技能\n---\n正文\n')
  writeFileSync(join(home, 'skills', 'dropped', 'SKILL.md'), '---\nname: dropped\ndescription: 会被停用的技能\n---\n正文\n')

  const root = new Context()
  root.plugin(SkillRegistry, {})
  for (let i = 0; i < 40 && !root.skills; i++) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(root.skills, '技能注册表必须可用')

  // preset 层：真实的 dsh-skill-filesystem 注册进一个 scope，正如 standard preset 所做。
  const scope = createScope(root, {})
  scope.ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  await new Promise((resolve) => setTimeout(resolve, 150))

  // 走插件真实的入口，而不是手工拼一个等价物。
  apply(root, { dshHome: home, agentsHome, includeDefaultRoots: true, log: false })
  await new Promise((resolve) => setTimeout(resolve, 120))

  const agent = { id: 'agent-under-test', ctx: scope.ctx }
  root.emit('agent/created', { agent })
  await new Promise((resolve) => setTimeout(resolve, 120))

  return {
    root,
    scope,
    home,
    cwd,
    agent,
    runtime: () => runtimeOf(root),
    /**
     * agent 所在层解析出的技能。
     *
     * 注意这里**不能**图省事写成 `scope.ctx.get('skills').snapshot({})` —— 读操作只看
     * `options.scope`，不从上下文推断，那样读到的是 global 层的空结果。本测试因此同
     * `lib/scope.js` 用同一套显式 scope 的读法，并顺带验证两种取 key 的方式一致。
     */
    agentSkills: async () => {
      const viaHelper = scopeKeyOf(scope.ctx)
      const viaUpstream = scopeOf(scope.ctx)
      assert.equal(viaHelper, viaUpstream, 'lib/scope.js 自行解析出的作用域 key 必须与上游一致')
      const snapshot = await root.skills.snapshot({ scope: viaHelper })
      return snapshot.skills.map((skill) => ({ name: skill.name, model: skill.invocation.modelInvocable, provider: skill.provider }))
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('未设覆盖时，agent 层看到 preset 层文件系统提供的全部技能', async () => {
  const env = await boot()
  try {
    const skills = await env.agentSkills()
    const names = skills.map((skill) => skill.name).sort()
    assert.deepEqual(names, ['dropped', 'kept'], `agent 应当看到两条技能，实际：${JSON.stringify(skills)}`)
    for (const skill of skills) assert.equal(skill.provider, 'filesystem', '没有覆盖时一切由文件系统提供方供给')
  } finally {
    env.cleanup()
  }
})

test('停用后，该 agent 作用域里的裁决真的翻转（不碰源文件）', async () => {
  const env = await boot()
  try {
    const before = await env.agentSkills()
    assert.equal(before.find((skill) => skill.name === 'dropped').model, true)

    // 走插件真实的策略接口，而不是直接写 state.json —— 后者不会更新内存状态、也不会
    // 通知注册表失效，改完等于没改（这条正是本测试第一版失败的原因）。
    const runtime = env.runtime()
    const result = runtime.setEnabled({ rootKey: 'dsh', name: 'dropped', enabled: false, cwd: env.cwd })
    assert.equal(result.ok, true, result.error)

    const after = await env.agentSkills()
    const dropped = after.find((skill) => skill.name === 'dropped')
    assert.equal(dropped.model, false, `停用必须作用到这个 agent，实际 provider=${dropped.provider} model=${dropped.model}`)
    assert.equal(dropped.provider, 'dsh-skills-manager', '胜出的应当是本插件的覆盖候选')

    const kept = after.find((skill) => skill.name === 'kept')
    assert.equal(kept.model, true, '没被覆盖的技能不受影响')

    assert.equal(
      readFileSync(join(env.home, 'skills', 'dropped', 'SKILL.md'), 'utf8').includes('disable-model-invocation'),
      false,
      '源文件必须一个字节都没被改动',
    )
  } finally {
    env.cleanup()
  }
})

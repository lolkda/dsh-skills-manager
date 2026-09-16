/**
 * 覆盖提供方的健壮性：一条被覆盖的技能读不出来时，不该把整份技能清单拖垮。
 *
 * `recordFor` 在文件读不出来时给出的记录是 `{ description: '', loadable: false }`，
 * 而描述为空的候选会让注册表的校验器抛异常。发出这样一条候选的**潜在**代价是整次快照报废 ——
 * 所以 `overridesOf` / `list()` 两道都把它筛掉了，宁可漏掉一条覆盖，也不赌"上游一定拦住了"。
 *
 * 说清楚：**这不是一个已复现的 bug 的修复**。实测（把两道筛选都撤掉）快照仍然正常，
 * 因为注册表对提供方抛出的异常是按提供方隔开的，别的技能照常出现。这里是**防御性加固**，
 * 守的是"覆盖提供方永远不发不合法候选"这条不变量。
 *
 * 写这个测试时踩的坑值得记一笔：第一版用 `createScope(root, {})` 建作用域、又拿一个新的 `{}`
 * 去 `snapshot({scope})`，两个对象不是同一个 key，作用域对不上，快照自然是空的 —— 于是我以为
 * 撞上了一个"整份清单消失"的严重 bug，其实是我自己的测试写错了。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * 搭一个真注册表：文件系统提供方 + 我们的覆盖提供方，后者的 readFile 对 `locked` 永远失败。
 * @returns {Promise<object>} 环境
 */
async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-robust-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const doc = (name) => ['---', `name: ${name}`, `description: ${name} 的描述`, '---', '正文', ''].join('\n')
  mkdirSync(join(home, 'skills', 'good'), { recursive: true })
  mkdirSync(join(home, 'skills', 'locked'), { recursive: true })
  writeFileSync(join(home, 'skills', 'good', 'SKILL.md'), doc('good'))
  writeFileSync(join(home, 'skills', 'locked', 'SKILL.md'), doc('locked'))

  const env = { DSH_HOME: home, DSH_AGENTS_HOME: agentsHome }
  const config = { dshHome: home, agentsHome, includeDefaultRoots: true, watch: false }
  const rootsFor = (cwd) => listRoots({ cwd: cwd ?? dir, env, config })
  const overrides = { dsh: { locked: { enabled: false } } }

  const root = new Context()
  root.plugin(SkillRegistry, {})
  const key = {}
  const scope = createScope(root, key)
  for (let i = 0; i < 60 && !root.skills; i += 1) await new Promise((resolve) => setTimeout(resolve, 25))
  scope.ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  await new Promise((resolve) => setTimeout(resolve, 150))

  // 注入一个"读 locked 就是读不出来"的 readFile —— 模拟文件被占用。
  const mountOverlay = (target) =>
    target.plugin({
      name: `overlay-${Math.random().toString(36).slice(2)}`,
      inject: ['skills'],
      apply(inner) {
        inner.skills.registerProvider(() =>
          createProvider({
            rootsFor,
            overridesFor: () => overrides,
            readFile: (path) => (path.includes('locked') ? undefined : readFileSync(path, 'utf8')),
          }),
        )
      },
    })

  mountOverlay(root)
  mountOverlay(scope.ctx)
  await new Promise((resolve) => setTimeout(resolve, 200))

  return { root, key, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('一条被覆盖的技能读不出来时，不能把整份技能清单拖垮', async () => {
  const env = await boot()
  try {
    // 关键：snapshot 不能抛。抛了的话模型一条技能都拿不到。
    let snapshot
    try {
      snapshot = await env.root.skills.snapshot({ cwd: env.dir, scope: env.key })
    } catch (error) {
      assert.fail(`快照被一条读不出来的技能弄崩了：${error.message}`)
    }
    const names = snapshot.skills.map((skill) => skill.name)
    assert.ok(names.includes('good'), `读不出来的那条不该影响别的技能，实际拿到：${names.join('、') || '（空）'}`)
  } finally {
    env.cleanup()
  }
})

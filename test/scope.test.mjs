/**
 * 作用域与 cwd 读取的单元测试。
 *
 * 这里钉住的是一类**不报错的错**：`snapshot()` 少了 cwd 不会失败，只会少掉项目级根
 * （`<项目>/.dsh/skills`、`<项目>/.agents/skills`）—— 于是插件的诊断与 `/registry` 报出的
 * 技能比模型实际看到的少，而且看不出来哪里不对。真机上就这么漏过一次：项目技能明明已经
 * 进了模型收到的系统提示，注册表视图里却没有它。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentCwd, agentScopeView, scopeKeyOf, summarizeSnapshot } from '../lib/scope.js'

/**
 * 造一个只在显式给出 scope 时才返回内容的假注册表 —— 与真实行为一致：不带 scope 只读
 * global 层，而真实部署里 global 层是空的。
 * @param {object[]} calls - 记录每次调用的参数
 * @returns {object} 假注册表
 */
function fakeRegistry(calls) {
  return {
    async snapshot(options) {
      calls.push(options)
      if (options?.scope === undefined) return { complete: true, skills: [] }
      return { complete: true, skills: [{ name: 'kept', invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem' }] }
    },
  }
}

/**
 * 造一个带作用域标记的假 agent。
 * @param {string|undefined} cwd - 会话工作目录
 * @returns {object} 假 agent
 */
function fakeAgent(cwd) {
  const ctx = {}
  ctx[Symbol('dsh.scope')] = { opaque: 'scope-1' }
  return { id: 'agent-1', ctx, session: cwd === undefined ? undefined : { header: { cwd } } }
}

test('agentCwd 只认 agent 自己会话的工作目录', () => {
  assert.equal(agentCwd(fakeAgent('F:/project/x')), 'F:/project/x')
  assert.equal(agentCwd(fakeAgent('  F:/project/x  ')), 'F:/project/x')
  assert.equal(agentCwd(fakeAgent(undefined)), undefined)
  assert.equal(agentCwd({ session: { header: { cwd: '   ' } } }), undefined)
  assert.equal(agentCwd(undefined), undefined)
})

test('agentScopeView 优先用 agent 自己的 cwd', async () => {
  const calls = []
  const view = await agentScopeView(fakeRegistry(calls), fakeAgent('F:/project/x'), { cwd: 'F:/somewhere-else' })
  assert.equal(view.resolved, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, 'F:/project/x', 'agent 自己的 cwd 说了算 —— 项目级根是按它解析的')
  assert.notEqual(calls[0].scope, undefined, 'scope 必须显式传，否则读到的是 global 层')
})

test('拿不到 agent 的 cwd 时才退回调用方给的', async () => {
  const calls = []
  await agentScopeView(fakeRegistry(calls), fakeAgent(undefined), { cwd: 'F:/fallback' })
  assert.equal(calls[0].cwd, 'F:/fallback')
})

test('两边都没有 cwd 时不编一个出来，也不报错', async () => {
  const calls = []
  const view = await agentScopeView(fakeRegistry(calls), fakeAgent(undefined))
  assert.equal(view.resolved, true)
  assert.equal('cwd' in calls[0], false, '没有 cwd 就不传这个字段，而不是传 undefined 或空串')
  assert.equal(view.cwd, undefined)
})

test('读不出作用域标识时如实拒绝，而不是退回 global 层的空结果', async () => {
  const calls = []
  const view = await agentScopeView(fakeRegistry(calls), { id: 'x', ctx: {} })
  assert.equal(view.resolved, false)
  assert.match(view.reason, /作用域标识/)
  assert.equal(calls.length, 0, '既然读不准，就不要去读')
})

test('scopeKeyOf 沿原型链找作用域标记', () => {
  const key = { opaque: 'inherited' }
  const parent = {}
  parent[Symbol('dsh.scope')] = key
  const child = Object.create(parent)
  assert.equal(scopeKeyOf(child), key, '作用域标记可能落在原型链上')
  assert.equal(scopeKeyOf({}), undefined)
  assert.equal(scopeKeyOf(null), undefined)
})

test('summarizeSnapshot 标出哪些来自本插件', () => {
  const summary = summarizeSnapshot({
    complete: true,
    skills: [
      { name: 'a', invocation: { modelInvocable: false, userInvocable: true }, provider: 'dsh-skills-manager', source: 'user-dsh' },
      { name: 'b', invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem', source: 'user-dsh' },
    ],
  })
  assert.equal(summary.skills[0].fromThisPlugin, true)
  assert.equal(summary.skills[1].fromThisPlugin, false)
  assert.equal(summary.skills[0].modelInvocable, false)
})

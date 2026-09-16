/**
 * 一致性核对的单元测试。
 *
 * 这个检测器的价值全在"会不会响"上：一个永远说"一致"的比对，比没有比对更糟 —— 它会
 * 给人一种已经核对过的错觉。所以这里既测它不误报，也测它该响的时候真的响。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compareWithRegistry, describeDivergence, FILESYSTEM_PROVIDER } from '../lib/divergence.js'

/**
 * 造一条本插件目录里的记录。
 * @param {string} name - 技能名
 * @param {object} [extra] - 覆盖字段
 * @returns {object} 记录
 */
function ours(name, extra = {}) {
  return { name, winner: true, loadable: true, ...extra }
}

/**
 * 造一条注册表快照里的技能。
 * @param {string} name - 技能名
 * @param {string} [provider] - 提供方名
 * @returns {object} 技能
 */
function theirs(name, provider = FILESYSTEM_PROVIDER) {
  return { name, provider, invocation: { modelInvocable: true, userInvocable: true } }
}

test('两边一致时如实说一致', () => {
  const result = compareWithRegistry({ skills: [ours('a'), ours('b')] }, [theirs('a'), theirs('b')])
  assert.equal(result.consistent, true)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.extra, [])
  assert.equal(result.ours, 2)
  assert.equal(result.registry, 2)
  assert.match(describeDivergence(result), /一致（2 条）/)
})

test('多报要点名 —— 界面上有、模型收不到', () => {
  const result = compareWithRegistry({ skills: [ours('a'), ours('ghost')] }, [theirs('a')])
  assert.equal(result.consistent, false)
  assert.deepEqual(result.missing, ['ghost'])
  assert.match(describeDivergence(result), /多报了 1 条.*ghost/)
})

test('少报也要点名 —— 技能在生效而界面看不到', () => {
  const result = compareWithRegistry({ skills: [ours('a')] }, [theirs('a'), theirs('invisible')])
  assert.equal(result.consistent, false)
  assert.deepEqual(result.extra, ['invisible'])
  assert.match(describeDivergence(result), /少报了 1 条.*invisible/)
})

test('只认文件系统提供方 —— 本插件自己的 overlay 不能算进去', () => {
  // 拿自己跟自己比，结论永远是"一致"，那这个检测器就白写了。
  const result = compareWithRegistry(
    { skills: [ours('a')] },
    [theirs('a'), theirs('a', 'dsh-skills-manager'), theirs('preset-only', 'some-preset')],
  )
  assert.equal(result.consistent, true, 'overlay 与其它提供方都不参与比对')
  assert.equal(result.registry, 1)
})

test('被遮蔽的与加载不上的纪录不参与比对', () => {
  // 它们本就不该出现在界面上，拿它们去比会造出一堆假差异。
  const result = compareWithRegistry(
    { skills: [ours('a'), ours('shadowed', { winner: false }), ours('broken', { loadable: false })] },
    [theirs('a')],
  )
  assert.equal(result.consistent, true)
  assert.equal(result.ours, 1)
})

test('缺字段与坏输入不抛异常', () => {
  assert.equal(compareWithRegistry({}, []).consistent, true)
  assert.equal(compareWithRegistry(undefined, undefined).consistent, true)
  assert.equal(compareWithRegistry({ skills: null }, null).consistent, true)
  assert.equal(compareWithRegistry({ skills: [null, ours('a')] }, [null, theirs('a')]).consistent, true)
})

test('多报与少报同时存在时两句话都要说', () => {
  const result = compareWithRegistry({ skills: [ours('ghost')] }, [theirs('invisible')])
  const text = describeDivergence(result)
  assert.match(text, /多报了 1 条.*ghost/)
  assert.match(text, /少报了 1 条.*invisible/)
})

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

test('比对的是合并后的结果：别的提供方供给的技能也算「收得到」', () => {
  // 这条测试原本写的是「只认文件系统提供方 —— 本插件自己的 overlay 不能算进去」，
  // 理由是"拿自己跟自己比，结论永远是一致"。那个理由站不住：注册表是**合并后**的视图，
  // 一条技能由谁供给并不改变它到没到模型手里。真机上正是这个过滤造出了 7 条假差异。
  const result = compareWithRegistry(
    { skills: [ours('a'), ours('b')] },
    [theirs('a'), theirs('b', 'some-preset')],
  )
  assert.equal(result.consistent, true, '别的提供方供给的同样是「模型收得到」')
  assert.equal(result.registry, 2)
  assert.equal(result.overlaid, 0, '不是本插件接管的，就不算接管数')
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

test('被覆盖层接管的技能不算多报 —— 换了胜出者，技能本身还在', () => {
  // 真机上踩到的：用户手动启用了 7 条技能，它们在注册表里的胜出者变成了我们自己的覆盖层
  // （rank 0 胜过 preset 层的 400）。旧实现「只认 filesystem」，于是这 7 条全被丢出
  // "注册表一侧"，界面报出「本插件多报了 7 条（DSH 没有，模型收不到）」——
  // 而模型其实一条不少地收到了。这种误报会让整个提示失去可信度，比不提示更糟。
  const result = compareWithRegistry(
    { skills: [ours('a'), ours('b')] },
    [theirs('a'), theirs('b', 'dsh-skills-manager')],
  )
  assert.equal(result.consistent, true, '覆盖层接管的技能仍在注册表里，不能算多报')
  assert.deepEqual(result.missing, [])
  assert.equal(result.registry, 2, '注册表一侧应当是合并之后的真实结果')
  assert.equal(result.overlaid, 1, '顺带说清有多少条由本插件接管')
  assert.match(describeDivergence(result), /其中 1 条由本插件的覆盖层接管/)
})

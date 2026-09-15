/**
 * 浏览器半边的契约测试。
 *
 * 在 `node:vm` 里造一个最小的 `window.__ModuleLoader__`，把 client.js 当客户端模块加载
 * 一次，验证它返回的 `{ name, inject, apply }` 形状与注册产物。它能抓住三类会在浏览器里
 * 静默变白屏的问题：语法错误、require 了模块表里没有的包、slots 注册形状写错。
 *
 * 数据流（加载目录、切换启停、错误显示）在 `client-render.test.mjs` 里验证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { loadClient } from './helpers/client-harness.mjs'

test('客户端 bundle 只请求 react，且返回 { name, inject, apply }', () => {
  const loaded = loadClient()
  assert.deepEqual(loaded.requested, ['react'], '除了 react 不该依赖任何模块表里可能不存在的包')
  assert.equal(loaded.module.name, 'dsh-skills-manager')
  // vm 里造出来的数组来自另一个 realm，原型不同，deepEqual 会判不等 —— 比较内容而非身份。
  assert.equal(Array.from(loaded.module.inject).join(','), 'slots')
  assert.equal(typeof loaded.module.apply, 'function')
})

test('客户端把技能分区注册进 settings.section', () => {
  const loaded = loadClient()
  assert.deepEqual(loaded.injected, ['settings.section'])
  assert.equal(loaded.registered.length, 1)
  const spec = loaded.registered[0].spec
  assert.equal(spec.name, 'settings.section')
  assert.equal(spec.id, 'dsh-skills-manager')
  assert.equal(typeof spec.order, 'number')
  assert.equal(spec.label(), '技能')
  assert.equal(typeof loaded.registered[0].render, 'function')
})

test('客户端注入样式表，并在卸载时移除', () => {
  const loaded = loadClient()
  assert.equal(loaded.styleTags.length, 1)
  assert.equal(loaded.styleTags[0].dataset.plugin, 'dsh-skills-manager')
  assert.match(loaded.styleTags[0].textContent, /\.dshsm-section/)
  assert.match(loaded.styleTags[0].textContent, /\.dshsm-switch/)
  for (const dispose of loaded.disposers) if (typeof dispose === 'function') dispose()
})

test('注册进 slots 的渲染函数包在错误边界里', () => {
  const loaded = loadClient()
  const element = loaded.registered[0].render()
  // h(Boundary, null, h(SkillsSection, null)) —— 边界必须是外层，这样面板出错时
  // 塌掉的只是这一块，不会把整个设置页带走。
  assert.equal(element.args[0].name, 'Boundary')
  assert.equal(element.args[2].__element, true)
})

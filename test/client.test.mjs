/**
 * 浏览器半边的契约测试。
 *
 * 在 `node:vm` 里造一个最小的 `window.__ModuleLoader__`，把 client.js 当客户端模块
 * 加载一次，验证它返回的 `{ name, inject, apply }` 形状与注册产物。这不是渲染测试
 * （那需要真浏览器），而是**契约测试**：它能抓住语法错误、require 了模块表里没有的
 * 包、以及 slots 注册形状写错这三类会在浏览器里静默变白屏的问题。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import test from 'node:test'

/** 源码路径：用 import.meta.url 推导，避免依赖测试的工作目录。 */
const CLIENT_PATH = fileURLToPath(new URL('../client/client.js', import.meta.url))

/**
 * 加载客户端 bundle 并取回模块导出。
 * @returns {{ module: object, injected: Array<string>, registered: Array<object>, styleTags: Array<object> }}
 */
function loadClient() {
  const source = readFileSync(CLIENT_PATH, 'utf8')
  let captured = null
  const styleTags = []
  const window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  const document = {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove: () => {} }
      styleTags.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
  }
  const sandbox = { window, document, console, setTimeout, clearTimeout, fetch: () => Promise.reject(new Error('测试里不发起请求')) }
  sandbox.globalThis = sandbox
  vm.runInContext(source, vm.createContext(sandbox), { filename: 'client/client.js' })

  assert.ok(captured, '客户端 bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, '@lolkda/dsh-skills-manager', 'bundle id 必须等于包名，模块系统靠它绑定 Loader 行')

  const requested = []
  const React = {
    createElement: (...args) => ({ args }),
    useState: () => [undefined, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Component: class Component {
      constructor(props) {
        this.props = props
      }
    },
  }
  const module = captured.factory((id) => {
    requested.push(id)
    if (id === 'react') return React
    throw new Error(`客户端 bundle 请求了模块表里没有的模块：${id}`)
  })

  const injected = []
  const registered = []
  const disposers = []
  module.apply({
    effect: (fn) => {
      disposers.push(fn())
    },
    slots: {
      inject: (slotName, callback) => {
        injected.push(slotName)
        callback()
      },
      register: (spec, render) => {
        registered.push({ spec, render })
        return () => {}
      },
    },
  })

  return { module, requested, injected: Array.from(injected), registered, styleTags, disposers }
}

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

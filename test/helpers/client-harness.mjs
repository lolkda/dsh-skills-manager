/**
 * 浏览器半边的测试台。
 *
 * 本仓库里没有 `react`（它由 DSH 的客户端模块表在运行时提供），所以这里既不加依赖也不
 * 假装渲染成功，而是实现一个**真的会执行函数组件与 hooks** 的迷你渲染器。它足以验证这块
 * 界面的数据流：加载目录、切换启停、状态与分支、错误提示 —— 也就是最容易出错、也最值得
 * 用测试钉住的那部分。真正的视觉呈现仍然只能在浏览器里看，这一点不装作已经覆盖。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import assert from 'node:assert/strict'

/** 客户端源码路径。 */
const CLIENT_PATH = fileURLToPath(new URL('../../client/client.js', import.meta.url))

/**
 * 造一个够用的 React 替身。
 *
 * 只实现这块界面用到的子集：函数组件、`createElement`、`useState` / `useEffect` /
 * `useCallback` / `useMemo`、以及一个 `Component` 基类（供错误边界继承）。
 * @param {object} runtime - 保存 hook 状态的运行时
 * @returns {object} React 替身
 */
function createReact(runtime) {
  return {
    createElement: (...args) => ({ args, __element: true }),
    useState: (initial) => {
      const slot = runtime.slot()
      if (!slot.initialized) {
        slot.initialized = true
        slot.value = typeof initial === 'function' ? initial() : initial
      }
      return [slot.value, (next) => runtime.setState(slot, next)]
    },
    useEffect: (fn, deps) => {
      const slot = runtime.slot()
      if (!depsEqual(slot, deps)) runtime.effect(fn)
    },
    // `useCallback` / `useMemo` 必须真的按依赖缓存：界面里 `reload` 依赖为空，
    // 若每次渲染都返回新函数，`useEffect([reload])` 就会反复触发，测试里的请求次数会失控。
    useCallback: (fn, deps) => {
      const slot = runtime.slot()
      if (!depsEqual(slot, deps)) slot.memo = fn
      return slot.memo
    },
    useMemo: (fn, deps) => {
      const slot = runtime.slot()
      if (!depsEqual(slot, deps)) slot.memo = fn()
      return slot.memo
    },
    Component: class Component {
      constructor(props) {
        this.props = props
      }

      get __isClassComponent() {
        return true
      }
    },
  }
}

/**
 * 依赖数组比较：未提供依赖视为每次都变，提供了就做浅比较。
 * @param {object} slot - hook 槽位
 * @param {unknown[]|undefined} deps - 依赖
 * @returns {boolean} 是否与上次相同
 */
function depsEqual(slot, deps) {
  const previous = slot.deps
  slot.deps = deps
  if (!Array.isArray(deps) || !Array.isArray(previous)) return false
  return deps.length === previous.length && deps.every((item, index) => Object.is(item, previous[index]))
}

/**
 * 迷你渲染运行时：按组件在树中的路径保存 hook 状态，并在 setState 后重渲染。
 * @returns {object} 运行时
 */
function createRuntime() {
  const slots = new Map()
  let path = ''
  let hookIndex = 0
  let pendingEffects = []
  let rerender = null
  return {
    beginComponent(nextPath) {
      path = nextPath
      hookIndex = 0
    },
    slot() {
      const key = `${path}#${hookIndex}`
      hookIndex += 1
      if (!slots.has(key)) slots.set(key, { initialized: false, value: undefined })
      return slots.get(key)
    },
    setState(slot, next) {
      slot.value = typeof next === 'function' ? next(slot.value) : next
      if (rerender) rerender()
    },
    effect(fn) {
      pendingEffects.push(fn)
    },
    takeEffects() {
      const taken = pendingEffects
      pendingEffects = []
      return taken
    },
    setRerender(fn) {
      rerender = fn
    },
  }
}

/**
 * 把元素树渲染成纯对象树。
 * @param {object} runtime - hook 运行时
 * @param {unknown} node - 元素
 * @param {string} [nodePath] - 当前路径
 * @returns {unknown} 渲染结果
 */
function walk(runtime, node, nodePath = '0') {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  // 组件可以返回数组（错误边界就是把收到的 children 原样返回），必须能展开。
  if (Array.isArray(node)) return node.map((child, index) => walk(runtime, child, `${nodePath}.${index}`)).filter((child) => child !== null)
  if (!node.__element) return null
  const [type, props, ...children] = node.args
  const rendered = children.map((child, index) => walk(runtime, child, `${nodePath}.${index}`))
  if (typeof type === 'function') {
    const mergedProps = { ...(props ?? {}), children: children.length > 0 ? children : undefined }
    // 类组件不能被当函数调用；错误边界就是类组件，漏掉这一条整棵树都渲染不出来。
    if (type.prototype && type.prototype.__isClassComponent === true) {
      const instance = new type(mergedProps)
      return walk(runtime, instance.render(), nodePath)
    }
    runtime.beginComponent(nodePath)
    return walk(runtime, type(mergedProps), nodePath)
  }
  return { type, props: props ?? {}, children: rendered.filter((child) => child !== null) }
}

/**
 * 在 `node:vm` 里加载客户端 bundle。
 * @param {object} [options] - 选项
 * @param {object} [options.fetch] - fetch 替身
 * @param {string} [options.source] - 直接给一份 bundle 源码。用于验证**服务端实际送出的字节**，
 *   而不只是仓库里那份源文件 —— 两者之间还隔着打包与传输。
 * @returns {object} 加载结果
 */
export function loadClient(options = {}) {
  const source = options.source ?? readFileSync(CLIENT_PATH, 'utf8')
  let captured = null
  const styleTags = []
  const window = {
    __ModuleLoader__: {
      load: (spec) => {
        captured = spec
      },
    },
  }
  const document = {
    querySelector: () => null,
    createElement: () => {
      const tag = { dataset: {}, textContent: '', remove: () => {} }
      styleTags.push(tag)
      return tag
    },
    head: { appendChild: () => {} },
  }
  const runtime = createRuntime()
  const React = createReact(runtime)
  const sandbox = {
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    fetch: options.fetch ?? (() => Promise.reject(new Error('测试里未提供 fetch'))),
  }
  sandbox.globalThis = sandbox
  vm.runInContext(source, vm.createContext(sandbox), { filename: options.filename ?? 'client/client.js' })

  assert.ok(captured, '客户端 bundle 必须调用 window.__ModuleLoader__.load')
  assert.equal(captured.id, '@lolkda/dsh-skills-manager', 'bundle id 必须等于包名，模块系统靠它绑定 Loader 行')

  const requested = []
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

  /** 等异步的副作用（fetch 链）落地。 */
  const flush = async (turns = 8) => {
    for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  }
  /** 渲染一次并跑掉本次产生的副作用（同步部分）。 */
  const render = () => {
    const tree = walk(runtime, registered[0].render(), 'root')
    for (const fn of runtime.takeEffects()) fn()
    return tree
  }
  /** 首次挂载：渲染、跑副作用、等异步、再渲染。 */
  const mount = async () => {
    render()
    await flush()
    return render()
  }
  /** 状态变化后重新渲染，并等异步副作用落地。 */
  const update = async () => {
    render()
    await flush()
    return render()
  }

  return {
    module,
    requested,
    injected,
    registered,
    styleTags,
    disposers,
    runtime,
    render,
    mount,
    update,
    flush,
  }
}

/**
 * 造一个 fetch 替身，记录每次调用并按键返回固定响应。
 * @param {object} routes - 路径 → 响应体（或返回响应体的函数）
 * @returns {Function} fetch 替身，带 `calls` 数组
 */
export function makeFetch(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined })
    const path = String(url).split('?')[0]
    const handler = routes[path] ?? routes['*']
    const payload = typeof handler === 'function' ? handler({ url, method, init }) : handler
    if (payload === undefined) throw new Error(`测试没有为 ${method} ${path} 准备响应`)
    return { status: 200, json: async () => payload }
  }
  fetch.calls = calls
  return fetch
}

/**
 * 把渲染结果里所有文本收集成一串，便于做包含性断言。
 * @param {unknown} node - 渲染结果
 * @returns {string} 文本
 */
export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (node.children) return `${textOf(node.props?.className ?? '')} ${node.children.map(textOf).join(' ')}`
  return ''
}

/**
 * 深度优先找出第一个满足条件的节点。
 * @param {unknown} node - 渲染结果
 * @param {(item: object) => boolean} predicate - 判定
 * @returns {object|undefined} 命中的节点
 */
export function findFirst(node, predicate) {
  return findAll(node, predicate)[0]
}

/**
 * 深度优先找出所有满足条件的节点。
 * @param {unknown} node - 渲染结果
 * @param {(item: object) => boolean} predicate - 判定
 * @param {object[]} [found] - 收集数组
 * @returns {object[]} 命中的节点
 */
export function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) findAll(item, predicate, found)
    return found
  }
  if (node.type !== undefined && predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}

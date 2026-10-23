/**
 * 宿主半边的测试夹具：临时 DSH_HOME、真实技能注册表、被捕获的 /api 端点与工具。
 *
 * 抽出来是因为全链路测试（`test/fullstack.test.mjs`）要用同一套环境 —— 让界面表单发出的
 * 请求真的走进真实端点，而不是两边各自对着假接口自说自话。
 *
 * 端点现在注册进官方 `/api` 通道的精确路由表（`connection.fetch.register`），所以这里
 * 捕获的是那张表里的条目，并按 Fetch 语义（`Request` 进、`Response` 出）调用它们 ——
 * 宿主在真实运行时会先跑完 Host/Origin fence 与浏览器鉴权，本夹具不模拟那一层：
 * 到达 handler 的请求在契约上就已经是可信且已认证的。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { apply } from '../../lib/index.js'

/**
 * 造一个官方 `/api` 端点注册表的替身，顺便记下被注册的条目。
 * @returns {{ routes: object[], service: object }} 捕获表与服务
 */
export function connectionSpy() {
  const routes = []
  return {
    routes,
    service: {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {
            const index = routes.indexOf(route)
            if (index >= 0) routes.splice(index, 1)
          }
        },
      },
    },
  }
}

/**
 * 按路径取一条已注册的端点。
 * @param {object[]} routes - 已注册条目
 * @param {string} path - 完整路径（可带查询串）
 * @returns {object|undefined} 端点
 */
export function routeOf(routes, path) {
  const pathname = path.split('?')[0].replace(/\/+$/, '')
  return routes.find((route) => route.path === pathname)
}

/**
 * 搭起整套环境：临时 DSH_HOME、真实注册表、被捕获的端点与工具。
 * @returns {Promise<object>} 环境
 */
export async function boot(options = {}) {
  const agents = options.agents
  const sessions = options.sessions
  const deferWebServer = options.deferWebServer === true
  const deferConnection = options.deferConnection === true
  const deferTools = options.deferTools === true
  let lateWebServer = false
  let lateConnection = false
  let lateTools = false
  const pending = []
  // webServer 仍然要假：就绪条件里有它（`connection` 也只有在它出现后才挂 `/api`）。
  // 顺手记下有没有人往它上面直注册路由 —— 0.3.0 起本插件不该这么做了。
  const rawRoutes = []
  const webServerService = {
    register(spec) {
      rawRoutes.push(spec)
      return () => {
        const index = rawRoutes.indexOf(spec)
        if (index >= 0) rawRoutes.splice(index, 1)
      }
    },
  }
  const spy = connectionSpy()
  const toolsService = {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-plugin-'))
  const home = join(dir, '.dsh')
  const agentsHome = join(dir, '.agents')
  const cwd = join(dir, 'project')
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(home, 'skills', 'plain'), { recursive: true })
  mkdirSync(join(home, 'skills', 'locked'), { recursive: true })
  writeFileSync(join(home, 'skills', 'plain', 'SKILL.md'), '---\nname: plain\ndescription: 普通技能\n---\n普通正文\n')
  writeFileSync(
    join(home, 'skills', 'locked', 'SKILL.md'),
    '---\nname: locked\ndescription: 文件声明不可被模型调用\ndisable-model-invocation: true\n---\n锁定正文\n',
  )

  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  ctx.plugin(skillFilesystem, { dshHome: home, agentsHome, watch: false })
  for (let i = 0; i < 40 && !ctx.skills; i++) await new Promise((r) => setTimeout(r, 25))

  const routes = spy.routes
  const tools = []
  const effectDisposers = []
  const fakeCtx = {
    skills: ctx.skills,
    effect(fn) {
      const dispose = fn()
      effectDisposers.push(dispose)
      return dispose
    },
    get(service) {
      // deferX 模拟真机上真实发生过的时序：插件被挂载时依赖还没出现。
      if (service === 'webServer') return deferWebServer && !lateWebServer ? undefined : webServerService
      if (service === 'connection') return deferConnection && !lateConnection ? undefined : spy.service
      if (service === 'tools') return deferTools && !lateTools ? undefined : toolsService
      // 只有显式传入时才提供 agents 服务，用来覆盖 /registry 的「有 agent」分支。
      if (service === 'agents') return agents
      // 同理，sessions 只在显式传入时提供：/catalog 的 cwd 候选列表来自它。
      if (service === 'sessions') return sessions
      return undefined
    },
    inject(services, callback) {
      pending.push({ services, callback })
      return () => {}
    },
    on() {
      return () => {}
    },
  }

  apply(fakeCtx, { dshHome: home, agentsHome, includeDefaultRoots: true, log: false })

  return {
    dir,
    home,
    cwd,
    routes,
    rawRoutes,
    tools,
    pending,
    registry: ctx.skills,
    registryReady: Boolean(ctx.skills),
    /**
     * 让此前缺失的服务突然出现，并触发所有在等它的延迟注入。
     * @param {string[]} services - 出现的服务名
     * @returns {void}
     */
    provide(services) {
      for (const service of services) {
        if (service === 'webServer') lateWebServer = true
        if (service === 'connection') lateConnection = true
        if (service === 'tools') lateTools = true
      }
      const still = []
      for (const item of pending.splice(0)) {
        if (item.services.every((service) => fakeCtx.get(service) !== undefined)) item.callback(fakeCtx)
        else still.push(item)
      }
      pending.push(...still)
    },
    request: (method, path, body, host = '127.0.0.1:3080') => call(routeOf(routes, path), method, path, body, host),
    cleanup: () => {
      for (const dispose of effectDisposers) if (typeof dispose === 'function') dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 打一次请求。
 *
 * 走的是端点的 Fetch 形态，并复刻官方通道的分发规则：**只在声明过的方法上分发**，
 * 其它方法连 handler 都进不了（真实通道回纯文本 `not found`）。这条规则必须在这里
 * 也成立，否则测试会以为未声明的方法能拿到我们自己的 405 —— 真机上那根本到不了我们。
 * Host 头只是让请求看起来像从某个地址来的：宿主在调用 handler 之前就完成了
 * fence 与浏览器鉴权，所以它不参与任何判定。
 * @param {object} route - 捕获到的端点定义
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径（可带查询串）
 * @param {object} [body] - 请求体
 * @param {string} [host] - Host 头
 * @returns {Promise<object>} `{ statusCode, ...JSON 响应体 }`，非 JSON 响应给 `text`
 */
export async function call(route, method, path, body, host = '127.0.0.1:3080') {
  assert.ok(route, `没有注册 ${path} 的 /api 精确端点`)
  if (!route.methods.includes(method)) return { statusCode: 404, text: 'not found' }
  const headers = { host }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const request = new Request(`http://dsh.internal${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await route.fetch(request)
  const text = await response.text()
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) return { statusCode: response.status, text }
  return { statusCode: response.status, ...(text ? JSON.parse(text) : {}) }
}

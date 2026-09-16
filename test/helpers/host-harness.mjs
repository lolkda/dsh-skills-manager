/**
 * 宿主半边的测试夹具：临时 DSH_HOME、真实技能注册表、被捕获的路由与工具。
 *
 * 抽出来是因为全链路测试（`test/fullstack.test.mjs`）要用同一套环境 —— 让界面表单发出的
 * 请求真的走进真实路由，而不是两边各自对着假接口自说自话。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

import { apply } from '../../lib/index.js'

/**
 * 搭起整套环境：临时 DSH_HOME、真实注册表、被捕获的路由与工具。
 * @returns {Promise<object>} 环境
 */
export async function boot(options = {}) {
  const agents = options.agents
  const sessions = options.sessions
  const deferWebServer = options.deferWebServer === true
  const deferTools = options.deferTools === true
  let lateWebServer = false
  let lateTools = false
  const pending = []
  const webServerService = {
    register(spec) {
      routes.push(spec)
      return () => {
        routes.length = 0
      }
    },
  }
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

  const routes = []
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
      // deferWebServer 模拟真机上真实发生过的时序：插件被挂载时 webServer 还没出现。
      if (service === 'webServer') return deferWebServer && !lateWebServer ? undefined : webServerService
      if (service === 'tools') return deferTools && !lateTools ? undefined : toolsService
      if (service === 'webRuntime') return { trustedHosts: [] }
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
        if (service === 'tools') lateTools = true
      }
      const still = []
      for (const item of pending.splice(0)) {
        if (item.services.every((service) => fakeCtx.get(service) !== undefined)) item.callback(fakeCtx)
        else still.push(item)
      }
      pending.push(...still)
    },
    request: (method, path, body, host = '127.0.0.1:3080') => call(routes[0], method, path, body, host),
    cleanup: () => {
      for (const dispose of effectDisposers) if (typeof dispose === 'function') dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 造一个最小请求对象。
 * @param {object} options - 请求参数
 * @returns {object} 请求
 */
function makeReq({ method, url, body, host }) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host }
  req.resume = () => {}
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

/**
 * 造一个最小响应对象。
 * @returns {object} 响应
 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(text) {
      this.chunks.push(text)
    },
    body() {
      return JSON.parse(this.chunks.join(''))
    },
  }
}

/**
 * 打一次请求。
 * @param {object} route - 捕获到的路由定义
 * @param {string} method - HTTP 方法
 * @param {string} path - 路径
 * @param {object} [body] - 请求体
 * @param {string} [host] - Host 头
 * @returns {Promise<{ statusCode: number, body: object }>} 响应
 */
export async function call(route, method, path, body, host = '127.0.0.1:3080') {
  assert.ok(route, '路由没有注册')
  const res = makeRes()
  await route.handler(makeReq({ method, url: path, body, host }), res)
  return { statusCode: res.statusCode, ...res.body() }
}

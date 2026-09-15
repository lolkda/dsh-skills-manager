/**
 * HTTP 路由，服务浏览器半边。
 *
 * 两条最要紧的约定：
 *
 *  1. **`/registry` 读的是注册表本身**，不是本插件自己的状态。它返回 `ctx.skills.snapshot()`
 *     的真实裁决结果 —— 谁赢了、赢得了什么策略、来自哪个提供方。启停到底有没有生效，
 *     由它回答。一个只报告「我写了什么」的接口无法证明任何事。
 *
 *  2. **请求里的 rootKey 一律查表**。外部字符串从不会直接拼进文件路径：先用
 *     `runtime.rootsFor(cwd)` 取根列表，再用 key 查表，查不到就拒绝。形状校验
 *     （`normalizeRootKey`）只是早点失败，不是防线。
 */

import { readFileSync } from 'node:fs'

import { normalizeRootKey } from './roots.js'
import { agentScopeView, summarizeSnapshot } from './scope.js'
import { logPath } from './store.js'
import {
  createSkill,
  importDirectory,
  importMarkdown,
  importZip,
  listTrash,
  moveToTrash,
  purgeFromTrash,
  restoreFromTrash,
  writeSkillContent,
} from './operations.js'

/**
 * 所有路由的共同前缀。
 *
 * **刻意不放在 `/api` 之下**，这是真机踩出来的：
 *
 *  1. `dsh-client-connection` 用 `{kind:'prefix', path:'/api'}` 注册了一个鉴权路由
 *     （见它源码里的 `requestRejection`，拒绝时 `res.end('unauthorized')`）。前缀路由
 *     **先注册先匹配**，而本插件的 bundle 排在 profile bundles 的最后，于是我们的每个
 *     `/api/...` 请求都先撞上那个鉴权，恒定 401 —— 与请求内容无关。
 *  2. `/api/dsh-skills-manager` 还被 `@michengai/dsh-skills-manager` 占着，同前缀的
 *     第二次注册会抛错，让本插件整个宿主半边挂载失败。
 *
 * `@lolkda/dsh-prompt-manager` 的 `/dsh-prompt-manager` 就是这个问题的既有解法：
 * 插件自己的路由用独占的非 `/api` 前缀。鉴权由本文件自己的 `validateHost` 负责
 * （只放行回环与显式受信主机）。
 */
export const ROUTE_PREFIX = '/dsh-skills-manager'

/** JSON 请求体上限。ZIP 以 base64 传输，会膨胀约 1/3。 */
const MAX_BODY_BYTES = 48 << 20

/**
 * 挂载路由。
 * @param {object} ctx - 上下文
 * @param {object} webServer - `ctx.webServer`
 * @param {object} runtime - `createRuntime()` 的产物
 * @returns {() => void} 注销函数
 */
export function installRoutes(ctx, webServer, runtime) {
  const trustedHosts = Array.isArray(ctx.get?.('webRuntime')?.trustedHosts) ? ctx.get('webRuntime').trustedHosts : []
  const route = webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => handle(req, res, runtime, trustedHosts, ctx),
  })
  // 成功也要留痕，否则日志里只剩"还没就绪"，看不出它后来到底装上了没有。
  runtime.log('routes-mounted', `HTTP 路由已注册到 ${ROUTE_PREFIX}`)
  return typeof route === 'function' ? route : () => route?.dispose?.()
}

/**
 * 从会话服务里取当前工作目录。
 *
 * 项目级技能根取决于 cwd，而浏览器半边拿不到会话的 cwd 时不能靠猜 —— 宿主进程的
 * `process.cwd()` 是 profile 目录，用它算出来的「项目技能」会是完全错误的一批。
 * 因此这里向会话服务要最近一个会话的 cwd。
 * @param {object} ctx - 上下文
 * @returns {string|undefined} cwd
 */
export function sessionCwd(ctx) {
  const sessions = ctx?.get?.('sessions')
  if (!sessions) return undefined
  let list
  try {
    list = typeof sessions.list === 'function' ? sessions.list() : undefined
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  for (const session of list) {
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd.trim()) return cwd.trim()
  }
  return undefined
}

/**
 * 处理一次请求。
 * @param {object} req - 请求
 * @param {object} res - 响应
 * @param {object} runtime - 运行时
 * @param {string[]} trustedHosts - 额外允许的 Host
 * @param {object} ctx - 上下文
 * @returns {Promise<void>} 完成
 */
async function handle(req, res, runtime, trustedHosts, ctx) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(/\/+$/, '')
  const guard = validateHost(req, trustedHosts)
  if (guard) return json(res, guard.statusCode, { ok: false, code: guard.code, error: guard.error })

  const requested = url.searchParams.get('cwd')
  const discovered = sessionCwd(ctx)
  if (discovered) runtime.setDefaultCwd(discovered)
  const cwd = requested || discovered || undefined
  try {
    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/catalog`) return json(res, 200, catalogResponse(runtime, cwd))
    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/registry`) return json(res, 200, await registryResponse(runtime, cwd, ctx))
    if (req.method === 'GET' && path === `${ROUTE_PREFIX}/skill/content`) {
      return json(res, 200, readContent(runtime, cwd, url.searchParams.get('rootKey'), url.searchParams.get('name')))
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'method.notAllowed', error: '只支持 GET 与 POST' })
    const body = await readJson(req)
    if (body === TOO_LARGE) return json(res, 413, { ok: false, code: 'body.tooLarge', error: '请求体过大' })
    return json(res, 200, dispatch(path, body, runtime, cwd))
  } catch (error) {
    return json(res, 500, { ok: false, code: 'internal', error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * 处理一个 POST 端点。
 * @param {string} path - 路径
 * @param {object} body - 请求体
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 请求指定的工作目录
 * @returns {object} 响应体
 */
function dispatch(path, body, runtime, cwd) {
  const lookup = resolveTarget(runtime, cwd, body.rootKey)
  switch (path) {
    case `${ROUTE_PREFIX}/policy`:
      return runtime.setEnabled({ rootKey: body.rootKey, name: body.name, enabled: normalizeEnabled(body.enabled), cwd })
    case `${ROUTE_PREFIX}/skill/create`:
      if (!lookup.ok) return lookup
      return finish(runtime, cwd, createSkill({ root: lookup.root, name: body.name, description: body.description, whenToUse: body.whenToUse, body: body.body }))
    case `${ROUTE_PREFIX}/skill/save`: {
      if (!lookup.ok) return lookup
      const skill = findSkill(runtime, cwd, body.rootKey, body.name)
      if (!skill.ok) return skill
      return finish(runtime, cwd, writeSkillContent({ docPath: skill.skill.docPath, rootPath: lookup.root.path, content: body.content }))
    }
    case `${ROUTE_PREFIX}/skill/trash`: {
      if (!lookup.ok) return lookup
      const skill = findSkill(runtime, cwd, body.rootKey, body.name)
      if (!skill.ok) return skill
      const result = moveToTrash({ dshHome: runtime.settings.dshHome, root: lookup.root, skill: skill.skill })
      // 删掉的技能要连它的启停覆盖一起清掉，否则同名技能以后被重建时会莫名其妙是停用状态。
      if (result.ok) runtime.setEnabled({ rootKey: body.rootKey, name: body.name, enabled: null, cwd })
      return finish(runtime, cwd, result)
    }
    case `${ROUTE_PREFIX}/trash/restore`:
      return finish(runtime, cwd, restoreFromTrash({ dshHome: runtime.settings.dshHome, id: body.id, roots: runtime.rootsFor(cwd) }))
    case `${ROUTE_PREFIX}/trash/purge`:
      return finish(runtime, cwd, purgeFromTrash({ dshHome: runtime.settings.dshHome, id: body.id }))
    case `${ROUTE_PREFIX}/skill/import`:
      if (!lookup.ok) return lookup
      return finish(runtime, cwd, importInto(lookup.root, body))
    default:
      return { ok: false, code: 'route.unknown', error: `未知端点：${path}` }
  }
}

/**
 * 按请求声明的来源执行导入。
 * @param {object} root - 目标根
 * @param {object} body - 请求体
 * @returns {object} 结果
 */
function importInto(root, body) {
  const overwrite = body.overwrite === true
  if (body.kind === 'zip') {
    if (typeof body.base64 !== 'string' || !body.base64) return { ok: false, code: 'import.empty', error: '没有收到 ZIP 内容' }
    return importZip({ root, buffer: Buffer.from(body.base64, 'base64'), overwrite })
  }
  if (body.kind === 'markdown') {
    if (typeof body.content !== 'string') return { ok: false, code: 'import.empty', error: '没有收到 Markdown 内容' }
    return importMarkdown({ root, fileName: typeof body.fileName === 'string' ? body.fileName : 'SKILL.md', data: Buffer.from(body.content, 'utf8'), overwrite })
  }
  if (body.kind === 'path') {
    if (typeof body.path !== 'string' || !body.path.trim()) return { ok: false, code: 'import.empty', error: '没有给出源目录' }
    return importDirectory({ root, sourcePath: body.path.trim(), overwrite })
  }
  return { ok: false, code: 'import.unknownKind', error: `不支持的导入方式：${body.kind}` }
}

/**
 * 读取一条技能的完整文档文本，供界面上的编辑器使用。
 *
 * 走服务端读文件而不是让浏览器直接拿路径：技能文件可能在任何卷上，且路径永远不该
 * 出现在客户端的可控输入里。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @param {string|null} rootKey - 根 key
 * @param {string|null} name - 技能名
 * @returns {object} 响应体
 */
function readContent(runtime, cwd, rootKey, name) {
  const found = findSkill(runtime, cwd, rootKey, name)
  if (!found.ok) return found
  let text
  try {
    text = readFileSync(found.skill.docPath, 'utf8')
  } catch (error) {
    return { ok: false, code: 'skill.unreadable', error: `无法读取技能文件：${error instanceof Error ? error.message : String(error)}` }
  }
  return {
    ok: true,
    name: found.skill.name,
    path: found.skill.docPath,
    rootKey: found.skill.rootKey,
    loadable: found.skill.loadable,
    diagnostics: found.skill.diagnostics,
    content: text,
  }
}

/**
 * 组装目录响应。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @returns {object} 响应体
 */
function catalogResponse(runtime, cwd) {
  const catalog = runtime.catalogFor(cwd)
  return {
    ok: true,
    data: {
      cwd: cwd ?? runtime.defaultCwd,
      roots: catalog.roots.map((root) => ({
        key: root.key,
        source: root.source,
        scope: root.scope,
        rank: root.rank,
        path: root.path,
        mutable: root.mutable,
        exists: root.exists,
        skills: root.skills,
      })),
      skills: catalog.skills,
      overrides: runtime.state.overrides,
      diagnostics: catalog.diagnostics,
      trash: listTrash(runtime.settings.dshHome),
      damaged: runtime.loaded.damaged ? runtime.loaded.reason : null,
      logPath: runtime.settings.log ? logPath(runtime.settings.dshHome) : null,
    },
  }
}

/**
 * 读取注册表当前的真实裁决结果。
 *
 * 这是本插件的验收口：它调的是 `ctx.skills`，不是我们自己的视图。若某条技能在这里
 * 仍是 `modelInvocable: true`，那么无论状态接口怎么说，它都没被停用。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @returns {Promise<object>} 响应体
 */
async function registryResponse(runtime, cwd, ctx) {
  const resolve = cwd ?? runtime.defaultCwd
  const skills = runtime.registry
  if (!skills || typeof skills.snapshot !== 'function') {
    return { ok: false, code: 'registry.unavailable', error: '当前上下文没有技能注册表' }
  }

  // 宿主层快照**不是**会话看到的那一层。技能由 preset 层提供，而 `dsh-skill` 的候选来自
  // `[layers.global, ...chainLayers(scope)]`；`snapshot()` 只按 `options.scope` 选层，不会
  // 从调用的上下文推断。所以不带 scope 读到的永远是 global —— 在真实部署里那是空的。
  // 这里对每个 agent 显式带上它自己的作用域 key，读到的才是模型真正看到的那一份。
  const agents = ctx?.get?.('agents')
  const list = agents && typeof agents.list === 'function' ? agents.list() : []
  const perAgent = []
  for (const agent of Array.isArray(list) ? list : []) {
    const id = String(agent?.id ?? agent?.name ?? perAgent.length)
    try {
      const view = await agentScopeView(skills, agent, { cwd: resolve })
      perAgent.push(view.resolved ? { id, ...summarizeSnapshot(view) } : { id, resolved: false, reason: view.reason })
    } catch (error) {
      perAgent.push({ id, resolved: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const host = summarizeSnapshot(await skills.snapshot({ cwd: resolve }))
  const effective = perAgent.find((item) => Array.isArray(item.skills))
  return {
    ok: true,
    data: {
      // `skills` 是**当前最能代表会话实际所见**的那一份；没有可用 agent 视图时退回宿主层，
      // 并且把 `scope` 与 `agents[].reason` 一并交代清楚，不假装读到的是会话视图。
      scope: effective ? 'agent' : 'host',
      complete: effective ? effective.complete : host.complete,
      skills: effective ? effective.skills : host.skills,
      host,
      agents: perAgent.map((item) => ({
        id: item.id,
        count: Array.isArray(item.skills) ? item.skills.length : null,
        reason: item.reason,
      })),
    },
  }
}

/**
 * 把根 key 解析成一个真实存在的根。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @param {unknown} rootKey - 请求里的 key
 * @returns {{ ok: true, root: object } | object} 结果
 */
function resolveTarget(runtime, cwd, rootKey) {
  const key = normalizeRootKey(rootKey)
  if (!key) return { ok: false, code: 'root.invalid', error: '缺少或非法的 rootKey' }
  const root = runtime.rootsFor(cwd).find((item) => item.key === key)
  if (!root) return { ok: false, code: 'root.unknown', error: `未知的技能根目录：${key}` }
  return { ok: true, root }
}

/**
 * 在胜出目录里找出一个技能。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @param {unknown} rootKey - 根 key
 * @param {unknown} name - 技能名
 * @returns {{ ok: true, skill: object } | object} 结果
 */
function findSkill(runtime, cwd, rootKey, name) {
  if (typeof name !== 'string' || !name) return { ok: false, code: 'skill.invalid', error: '缺少技能名' }
  const catalog = runtime.catalogFor(cwd)
  const winner = catalog.winners.get(name)
  if (!winner) return { ok: false, code: 'skill.unknown', error: `找不到名为 ${name} 的技能` }
  if (winner.rootKey !== rootKey) {
    return { ok: false, code: 'skill.shadowed', error: `${name} 实际由 ${winner.source} 下的同名技能生效，请改为操作它` }
  }
  if (winner.overrideShadowed) return { ok: false, code: 'skill.shadowed', error: `${name} 的覆盖被同名技能遮蔽` }
  return { ok: true, skill: winner }
}

/**
 * 把一次写操作的结果补上最新目录后返回。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @param {object} result - 操作结果
 * @returns {object} 响应体
 */
function finish(runtime, cwd, result) {
  if (!result || result.ok !== true) return result ?? { ok: false, code: 'internal', error: '操作没有返回结果' }
  return { ...result, catalog: catalogResponse(runtime, cwd).data }
}

/**
 * 收敛 enabled 字段。
 * @param {unknown} value - 请求里的值
 * @returns {boolean|null} 启用/停用/清除
 */
function normalizeEnabled(value) {
  if (value === null || value === 'clear') return null
  return value === true
}

/**
 * 校验请求的 Host 是否可信。
 *
 * 本插件的路由能改磁盘上的技能，而 DSH 的 Web 服务可能被反代或通过其它主机名访问；
 * 只放行回环地址与显式配置的受信主机，避免一个网页把用户的技能删掉。
 * @param {object} req - 请求
 * @param {string[]} trustedHosts - 额外受信主机
 * @returns {object|null} 拒绝时返回错误，放行时为 null
 */
export function validateHost(req, trustedHosts = []) {
  const raw = typeof req.headers?.host === 'string' ? req.headers.host : ''
  let parsed
  try {
    parsed = new URL(`http://${raw}`)
  } catch {
    return { statusCode: 403, code: 'host.forbidden', error: 'Host 头无法解析' }
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  if (hostname === 'localhost' || hostname === '::1') return null
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    return hostname.split('.').every((part) => Number(part) <= 255) ? null : { statusCode: 403, code: 'host.forbidden', error: 'Host 头非法' }
  }
  if (trustedHosts.some((entry) => String(entry).replace(/:\d+$/, '').toLowerCase() === hostname.toLowerCase())) return null
  return { statusCode: 403, code: 'host.forbidden', error: `拒绝来自 ${hostname} 的请求` }
}

/** 请求体超限的哨兵值。 */
const TOO_LARGE = Symbol('too-large')

/**
 * 读取并解析 JSON 请求体。
 * @param {object} req - 请求
 * @returns {Promise<object|symbol>} 解析结果或 TOO_LARGE
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        req.resume()
        resolve(TOO_LARGE)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`))
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      reject(error)
    })
  })
}

/**
 * 写一个 JSON 响应。
 * @param {object} res - 响应
 * @param {number} statusCode - 状态码
 * @param {object} body - 响应体
 * @returns {void}
 */
function json(res, statusCode, body) {
  const text = JSON.stringify(body)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

export { listTrash }

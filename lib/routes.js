/**
 * HTTP 端点，服务浏览器半边。
 *
 * 三条最要紧的约定：
 *
 *  1. **`/registry` 读的是注册表本身**，不是本插件自己的状态。它返回 `ctx.skills.snapshot()`
 *     的真实裁决结果 —— 谁赢了、赢得了什么策略、来自哪个提供方。启停到底有没有生效，
 *     由它回答。一个只报告「我写了什么」的接口无法证明任何事。
 *
 *  2. **请求里的 rootKey 一律查表**。外部字符串从不会直接拼进文件路径：先用
 *     `runtime.rootsFor(cwd)` 取根列表，再用 key 查表，查不到就拒绝。形状校验
 *     （`normalizeRootKey`）只是早点失败，不是防线。
 *
 *  3. **访问控制是宿主的，不是本文件的**。端点注册进官方 `/api` 通道的精确 Fetch
 *     路由表（`ctx.connection.fetch.register`），宿主的 `/api` 前缀处理器在我们之前
 *     跑完 Host/Origin fence 与浏览器会话鉴权 —— 未通过鉴权的请求根本到不了这里的
 *     `fetch`。所以本文件不再有自己的 Host 校验：谁到达这里，谁就已经通过了宿主。
 *     取舍见 .agents/notes/implemented/architecture/2026-10-11-official-api-fetch-routes.md。
 */

import { readFileSync } from 'node:fs'

import { normalizeRootKey, pathIdentity } from './roots.js'
import { findCatalogDocument } from './catalog.js'
import { compareWithRegistry } from './divergence.js'
import { agentCwd, agentScopeView, summarizeSnapshot } from './scope.js'
import { logPath } from './store.js'
import {
  createSkill,
  importDirectory,
  importMarkdown,
  importZip,
  deleteSkill,
  writeSkillContent,
} from './operations.js'

/**
 * 所有端点的共同前缀。
 *
 * 这是**官方 `/api` 通道下的精确路径**，不是自己挂在 `webServer` 上的前缀路由。
 * 为什么换注册方式（0.3.0 的破坏性改动，两条都是真机教训）：
 *
 *  1. 自己挂前缀路由要求 `webRuntime` 服务就绪，而 DSH 0.2.x 把它删了 —— 于是闸门
 *     永远不满足，路由静默地从未注册：服务端一切正常、日志只有「尚未就绪」，
 *     每个请求都 404。
 *  2. 官方注册表把 fence（回环、受信主机、监听地址）与浏览器会话鉴权都做完了才轮到
 *     我们，而旧的自挂前缀路由只有一份自己写的 Host 校验、没有任何会话鉴权。
 *
 * 精确路由不会互相踩：宿主按 pathname 查表，`/api/dsh-skills-manager/...` 不会再撞上
 * `/api` 那条前缀处理器里的鉴权拒绝，也不与别的插件的路径冲突（冲突会显式抛错）。
 */
export const ROUTE_PREFIX = '/api/dsh-skills-manager'

/**
 * 全部端点，以及每个端点真正使用的方法。
 *
 * 只声明自己真正用的那一个：官方通道按「路径 + 方法」分发，方法不在声明里就连 handler
 * 都进不了（宿主回它自己的 404）。所以本文件不需要再判方法，也没有什么 405 可返回 ——
 * 把方法写宽（例如读端点也声明 POST）只会让一个写错方法的调用走进业务逻辑。
 */
const ENDPOINTS = [
  { path: '/catalog', methods: ['GET'] },
  { path: '/registry', methods: ['GET'] },
  { path: '/skill/content', methods: ['GET'] },
  { path: '/policy', methods: ['POST'] },
  { path: '/skill/create', methods: ['POST'] },
  { path: '/skill/save', methods: ['POST'] },
  { path: '/skill/delete', methods: ['POST'] },
  { path: '/skill/import', methods: ['POST'] },
]

/** JSON 请求体上限。ZIP 以 base64 传输，会膨胀约 1/3。 */
const MAX_BODY_BYTES = 48 << 20

/**
 * 把端点注册进官方 `/api` 通道。
 *
 * 每个端点一条精确路由，共用一个处理器；请求到达时，宿主的 `/api` 处理器已经完成了
 * Host/Origin fence 与浏览器会话鉴权（见文件头注释第 3 条），所以这里拿到的
 * `request` 一定是可信且已认证的。
 * @param {object} ctx - 上下文（处理器要查 `sessions` / `agents`）
 * @param {object} connection - `ctx.connection`，须带 `fetch.register`
 * @param {object} runtime - `createRuntime()` 的产物
 * @returns {() => void} 注销函数
 */
export function installRoutes(ctx, connection, runtime) {
  if (!connection || typeof connection.fetch?.register !== 'function') {
    throw new Error('connection 服务缺少 fetch.register，无法注册 /api 端点')
  }
  const disposers = ENDPOINTS.map((endpoint) =>
    connection.fetch.register({
      path: `${ROUTE_PREFIX}${endpoint.path}`,
      methods: endpoint.methods,
      requestBody: 'buffered',
      fetch: (request) => handle(request, runtime, ctx),
    }),
  )
  // 成功也要留痕，否则日志里只剩"还没就绪"，看不出它后来到底装上了没有。
  runtime.log('routes-mounted', `已在 ${ROUTE_PREFIX} 下注册 ${ENDPOINTS.length} 条 /api 精确路由`)
  return () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
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
export function sessionCwds(ctx, limit = 12) {
  const sessions = ctx?.get?.('sessions')
  if (!sessions) return []
  let list
  try {
    list = typeof sessions.list === 'function' ? sessions.list() : undefined
  } catch {
    return []
  }
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const result = []
  for (const session of list) {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string') continue
    const trimmed = cwd.trim()
    if (!trimmed) continue
    // Windows 路径大小写不敏感、结尾斜杠等价，去重时统一一下，免得同一个目录列出好几遍。
    const identity = trimmed.replace(/[\/]+$/, '').toLowerCase()
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(trimmed)
    if (result.length >= limit) break
  }
  return result
}

/**
 * 取一个会话的工作目录作为默认值。
 *
 * 这只是**默认值**：会话可能有多个、顺序也不保证稳定，所以真正的用法是让调用方把这个值
 * 钉住并在后续请求里显式带回（`?cwd=`）。否则同一个面板的两次请求可能落到不同的项目上，
 * 项目级技能根会在用户毫无察觉的情况下换一套。
 * @param {object} ctx - 上下文
 * @returns {string|undefined} cwd
 */
export function sessionCwd(ctx) {
  return sessionCwds(ctx, 1)[0]
}

/**
 * 处理一次请求。
 *
 * 到达这里意味着两件事都已经被宿主做完：Host/Origin fence 与浏览器会话鉴权（所以这里
 * 既不查 Host 也不产生 401/403），以及**方法过滤**（方法不在该端点的声明里就不会分发
 * 过来，所以我们也不判方法）。剩下的只是路径分派。
 * @param {Request} request - 已认证的 Fetch 请求
 * @param {object} runtime - 运行时
 * @param {object} ctx - 上下文
 * @returns {Promise<Response>} 响应
 */
async function handle(request, runtime, ctx) {
  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '')

  const requested = url.searchParams.get('cwd')
  const sessionId = url.searchParams.get('sessionId')?.trim() || undefined
  const agents = sessionId ? ctx?.get?.('agents')?.list?.() : []
  const selectedCwd = agentCwd(Array.isArray(agents) ? agents.find(agent => agent.id === sessionId) : undefined)
  const candidates = sessionCwds(ctx)
  if (candidates[0]) runtime.setDefaultCwd(candidates[0])
  const cwd = requested || selectedCwd || candidates[0] || undefined
  try {
    if (path === `${ROUTE_PREFIX}/catalog`) return json(200, catalogResponse(runtime, cwd, candidates))
    if (path === `${ROUTE_PREFIX}/registry`) return json(200, await registryResponse(runtime, cwd, ctx, sessionId))
    if (path === `${ROUTE_PREFIX}/skill/content`) {
      return json(200, readContent(runtime, cwd, url.searchParams.get('rootKey'), url.searchParams.get('name'), url.searchParams.get('docPath')))
    }
    const body = await readJson(request)
    if (body === TOO_LARGE) return json(413, { ok: false, code: 'body.tooLarge', error: '请求体过大' })
    if (body === INVALID) return json(400, { ok: false, code: 'body.invalid', error: '请求体不是合法 JSON 对象' })
    return json(200, dispatch(path, body, runtime, cwd, candidates))
  } catch (error) {
    return json(500, { ok: false, code: 'internal', error: error instanceof Error ? error.message : String(error) })
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
function dispatch(path, body, runtime, cwd, candidates) {
  // 收成闭包，省得每个分支都把 cwd 与候选列表现抄一遍。
  const finish = (result) => withCatalog(runtime, cwd, result, candidates)
  const lookup = resolveTarget(runtime, cwd, body.rootKey)
  switch (path) {
    case `${ROUTE_PREFIX}/policy`:
      return runtime.setEnabled({ rootKey: body.rootKey, name: body.name, enabled: normalizeEnabled(body.enabled), cwd })
    case `${ROUTE_PREFIX}/skill/create`:
      if (!lookup.ok) return lookup
      return finish(createSkill({ root: lookup.root, name: body.name, description: body.description, whenToUse: body.whenToUse, body: body.body }))
    case `${ROUTE_PREFIX}/skill/save`: {
      if (!lookup.ok) return lookup
      const skill = findSkill(runtime, cwd, body.rootKey, body.name, body.docPath)
      if (!skill.ok) return skill
      return finish(writeSkillContent({ docPath: skill.skill.docPath, root: lookup.root, content: body.content }))
    }
    case `${ROUTE_PREFIX}/skill/delete`: {
      if (!lookup.ok) return lookup
      const skill = findSkill(runtime, cwd, body.rootKey, body.name, body.docPath)
      if (!skill.ok) return skill
      const result = deleteSkill({ root: lookup.root, skill: skill.skill })
      // 删掉的技能要连它的启停覆盖一起清掉，否则同名技能以后被重建时会莫名其妙是停用状态。
      if (result.ok && !runtime.catalogFor(cwd).skills.some(record => record.rootKey === skill.skill.rootKey && record.name === skill.skill.name)) {
        runtime.setEnabled({ rootKey: skill.skill.rootKey, name: skill.skill.name, enabled: null, cwd })
      }
      return finish(result)
    }
    case `${ROUTE_PREFIX}/skill/import`:
      if (!lookup.ok) return lookup
      return finish(importInto(lookup.root, body))
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
function readContent(runtime, cwd, rootKey, name, docPath) {
  const found = findSkill(runtime, cwd, rootKey, name, docPath)
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
function catalogResponse(runtime, cwd, candidates) {
  const catalog = runtime.catalogFor(cwd)
  return {
    ok: true,
    data: {
      cwd: cwd ?? runtime.defaultCwd,
      // 服务端能看到的其它工作目录。界面在多于一个时给出选择器，而不是替用户猜。
      candidates: candidates ?? [],
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
async function registryResponse(runtime, cwd, ctx, sessionId) {
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
      // agent 自己的 cwd 优先：项目级根就是按它解析的，用别的目录会报出另一套项目技能。
      // 拿不到 agent 的 cwd 时才退回请求里的，作为已知的近似。
      const view = await agentScopeView(skills, agent, { cwd: resolve })
      perAgent.push(view.resolved ? { id, agent, ...summarizeSnapshot(view) } : { id, agent, resolved: false, reason: view.reason })
    } catch (error) {
      perAgent.push({ id, agent, resolved: false, reason: error instanceof Error ? error.message : String(error) })
    }
  }

  const host = summarizeSnapshot(await skills.snapshot({ cwd: resolve }))
  // cwd 不是会话身份：同目录的旧会话可能只有覆盖层，不能替当前会话宣称技能缺失。
  // 有 sessionId 时严格按它选择；旧客户端未传时，仅允许唯一的同目录会话。
  const matching = perAgent.filter((item) => {
    const ownCwd = agentCwd(item.agent)
    return (sessionId === undefined || item.id === sessionId)
      && ownCwd !== undefined && pathIdentity(ownCwd) === pathIdentity(resolve)
  })
  const effective = matching.length === 1 && Array.isArray(matching[0].skills) ? matching[0] : undefined
  // 只有真的读到了某个 agent 的那一层，比对才有意义 —— 否则是在拿"宿主层的空结果"和
  // 我们的目录比，只会得到一堆假差异。
  const comparedCwd = effective ? (agentCwd(effective.agent) ?? resolve) : undefined
  let divergence
  if (effective && effective.complete !== false) {
    try {
      divergence = { checked: true, cwd: comparedCwd, ...compareWithRegistry(runtime.catalogFor(comparedCwd), effective.skills) }
    } catch (error) {
      divergence = { checked: false, reason: error instanceof Error ? error.message : String(error) }
    }
  } else {
    divergence = { checked: false, cwd: resolve, reason: effective
      ? '匹配 agent 的目录观测不完整，不能据此宣称核对一致'
      : matching.length > 1
        ? '同一目录存在多个会话，请指定当前会话后再核对'
        : sessionId !== undefined
          ? '指定会话没有与所选项目目录匹配的可用技能视图，不使用其它会话冒充核对'
          : '当前没有与所选项目目录匹配的可用 agent 视图，不使用其它项目冒充核对' }
  }
  return {
    ok: true,
    data: {
      // `skills` 是**当前最能代表会话实际所见**的那一份；没有可用 agent 视图时退回宿主层，
      // 并且把 `scope` 与 `agents[].reason` 一并交代清楚，不假装读到的是会话视图。
      cwd: resolve,
      agentId: effective?.id ?? null,
      scope: effective ? 'agent' : 'host',
      complete: effective ? effective.complete : host.complete,
      skills: effective ? effective.skills : host.skills,
      host,
      divergence,
      agents: perAgent.map((item) => ({
        id: item.id,
        cwd: agentCwd(item.agent),
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
function findSkill(runtime, cwd, rootKey, name, docPath) {
  const target = resolveTarget(runtime, cwd, rootKey)
  if (!target.ok) return target
  return findCatalogDocument(runtime.catalogFor(cwd), { rootKey: target.root.key, name, docPath })
}

/**
 * 把一次写操作的结果补上最新目录后返回。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @param {object} result - 操作结果
 * @returns {object} 响应体
 */
function withCatalog(runtime, cwd, result, candidates) {
  if (!result || result.ok !== true) return result ?? { ok: false, code: 'internal', error: '操作没有返回结果' }
  runtime.invalidate()
  return { ...result, catalog: catalogResponse(runtime, cwd, candidates).data }
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

/** 请求体超限的哨兵值。 */
const TOO_LARGE = Symbol('too-large')

/** 请求体不是合法 JSON 对象的哨兵值。 */
const INVALID = Symbol('invalid')

/**
 * 读取并解析 JSON 请求体。
 *
 * 体积上限在读到全部字节**之后**再判一次：宿主按它自己的上限（默认 300 MiB）已经缓冲过
 * 一遍，本插件这份 48 MiB 的限制是给自己的（ZIP 走 base64，膨胀约 1/3），宁可早点拒绝，
 * 也不让一个超大 base64 走进解码流程。
 * @param {Request} request - 已认证的请求
 * @returns {Promise<object|symbol>} 解析结果、TOO_LARGE 或 INVALID
 */
async function readJson(request) {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return TOO_LARGE
  let raw
  try {
    raw = await request.text()
  } catch {
    return INVALID
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) return TOO_LARGE
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : INVALID
  } catch {
    return INVALID
  }
}

/**
 * 造一个 JSON 响应。
 * @param {number} statusCode - 状态码
 * @param {object} body - 响应体
 * @returns {Response} 响应
 */
function json(statusCode, body) {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}


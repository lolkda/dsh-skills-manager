/**
 * 宿主半边入口。
 *
 * 这个插件挂载后做三件事：
 *  1. 把「用户显式启停过的技能」作为 rank 0 的候选送进 `ctx.skills`；
 *  2. 注册 `/api/lolkda-dsh-skills-manager/*` 供 Web 界面读写；
 *  3. 注册面向 Agent 的 skills 工具。
 *
 * 第 1 件事必须**注册两次**，这是本插件最容易做错的地方：`dsh-skill` 的注册表按
 * scope 分层，而 agent preset 会再挂一次 `dsh-skill-filesystem` 并注册进 preset
 * 自己的层（见 `dsh-agent-presets/presets/standard/agent.cordis.yml`）。读取时
 * 「最近层直接赢得重名」，所以只在宿主层插候选会被 preset 层原样压掉 —— 界面显示
 * 停用了、模型照样能加载。因此除了宿主行注册一次，还要为每个 agent 在其
 * `agent.ctx` 上再注册一次。
 */

import Schema from '@deepseek-ai/schemastery'

import { buildCatalog } from './catalog.js'
import { compareWithRegistry, describeDivergence } from './divergence.js'
import { createProvider, PROVIDER_NAME } from './provider.js'
import { installRoutes, ROUTE_PREFIX } from './routes.js'
import { OVERLAY_RANK, listRoots, resolveAgentsHome, resolveDshHome } from './roots.js'
import { agentScopeView } from './scope.js'
import { appendLog, emptyState, loadState, saveState, setOverride } from './store.js'
import { installTools } from './tools.js'

/** cordis 插件名，同时是 profile 里那一行的 id 来源。 */
export const name = 'dsh-skills-manager'

/**
 * 依赖清单。
 *
 * 只声明技能注册表，剩下的（Web、工具、会话、agents）都走「就绪后再装」的延迟注入。
 *
 * 两种写法各错一半，必须合起来用：
 *  - 只写 `ctx.get()` 会在服务就绪**之前**就判定"没有"，于是路由静默地从未注册 ——
 *    服务端一切正常、日志一片干净，只是每个请求都 404。
 *  - 全部写进 `inject` 会让插件在缺 Web 服务的 profile（headless、SDK）里根本不挂载，
 *    而启停是核心能力，不该被 Web 半边绑死。
 */
export const inject = ['skills']

/** 插件配置。 */
export const Config = Schema.object({
  includeDefaultRoots: Schema.boolean().default(true).description('是否包含项目根与用户根，与 dsh-skill-filesystem 的同名选项一致'),
  customSkillDirs: Schema.array(Schema.string()).default([]).description('rank 300 的额外技能根目录'),
  bundledSkillDir: Schema.string().description('rank 600 的内置技能根目录，只读'),
  dshHome: Schema.string().description('Harness 配置根，默认 $DSH_HOME 或 ~/.dsh'),
  agentsHome: Schema.string().description('共享 agent 配置根，默认 $DSH_AGENTS_HOME 或 ~/.agents'),
  log: Schema.boolean().default(true).description('是否把启停与写入操作追加到 $DSH_HOME/dsh-skills-manager.log'),
})

/**
 * 收敛配置并算出各根的解析基准。
 * @param {object} config - 插件配置
 * @returns {object} 归一化配置
 */
export function normalizeConfig(config = {}) {
  const dshHome = typeof config.dshHome === 'string' && config.dshHome.trim() ? config.dshHome.trim() : resolveDshHome()
  const agentsHome =
    typeof config.agentsHome === 'string' && config.agentsHome.trim() ? config.agentsHome.trim() : resolveAgentsHome()
  return {
    includeDefaultRoots: config.includeDefaultRoots !== false,
    customSkillDirs: Array.isArray(config.customSkillDirs) ? config.customSkillDirs.filter((d) => typeof d === 'string') : [],
    bundledSkillDir: typeof config.bundledSkillDir === 'string' ? config.bundledSkillDir : undefined,
    dshHome,
    agentsHome,
    log: config.log !== false,
  }
}

/**
 * 组装插件的运行时状态与全部依赖注入。
 *
 * 独立于 `apply()` 导出，是为了让测试能在没有 cordis 的情况下直接驱动状态变更、
 * 目录计算与操作 —— 那些逻辑占了本插件的大部分，不该只能通过启动一个 profile 来测。
 * @param {object} [config] - 插件配置
 * @returns {object} 运行时
 */
export function createRuntime(config = {}) {
  const settings = normalizeConfig(config)
  const loaded = loadState(settings.dshHome)
  let state = loaded.state
  const invalidators = new Set()
  /** 当前会话的 cwd 由调用方提供；缺省用进程 cwd，与 DSH 自己的项目根解析一致。 */
  let defaultCwd = process.cwd()

  const rootsFor = (cwd) => listRoots({ cwd: cwd ?? defaultCwd, env: process.env, config: settings })
  const overridesFor = () => state.overrides
  const catalogFor = (cwd) => buildCatalog({ roots: rootsFor(cwd), overrides: overridesFor() })

  /**
   * 让所有已注册的提供方失效，使下一次快照重新收集候选。
   * @returns {void}
   */
  const invalidate = () => {
    for (const invalidator of [...invalidators]) {
      try {
        invalidator()
      } catch {
        // 单个注册失效失败不应连累其它注册；下一次快照仍会走提供方。
      }
    }
  }

  /**
   * 写一条活动日志。
   * @param {string} event - 事件名
   * @param {string} detail - 细节
   * @returns {void}
   */
  const log = (event, detail) => {
    if (settings.log) appendLog(settings.dshHome, event, detail)
  }

  /**
   * 设定或清除一条启停覆盖。
   *
   * 顺序是「先落盘、再让提供方失效」：反过来的话，已经生效的策略在进程重启后会消失，
   * 用户看到的和下次启动后的不一致。
   * @param {{ rootKey: string, name: string, enabled: boolean|null }} input - 覆盖参数
   * @returns {{ ok: boolean, changed: boolean, code?: string, error?: string }} 结果
   */
  const setEnabled = (input) => {
    const root = rootsFor(input.cwd).find((item) => item.key === input.rootKey)
    if (!root) return { ok: false, changed: false, code: 'root.unknown', error: `未知的技能根目录：${input.rootKey}` }

    // 清除覆盖不要求技能还在：删除技能之后紧接着清理它的覆盖正是最常见的调用，
    // 而那一刻技能已经不在目录里了。若这里也去查 winners，清理就永远失败，
    // 于是同名技能以后被重建时会莫名继承一个停用状态。
    if (input.enabled === null) {
      const cleared = setOverride(state, input.rootKey, input.name, null)
      if (cleared.changed) {
        state = cleared.state
        saveState(settings.dshHome, state)
        invalidate()
        log('policy-clear', `清除 ${input.rootKey}/${input.name} 的策略覆盖`)
      }
      return { ok: true, changed: cleared.changed }
    }

    const catalog = catalogFor(input.cwd)
    const winner = catalog.winners.get(input.name)
    if (!winner) return { ok: false, changed: false, code: 'skill.unknown', error: `找不到名为 ${input.name} 的技能` }
    if (winner.rootKey !== input.rootKey) {
      return {
        ok: false,
        changed: false,
        code: 'skill.shadowed',
        error: `${input.name} 由 ${winner.source} 下的同名技能生效（rank ${winner.rank}），请改为操作该根目录下的技能`,
      }
    }
    if (!winner.invocationPolicyValid) {
      return { ok: false, changed: false, code: 'skill.invalid', error: `${input.name} 的调用策略写法非法，请先修正文件` }
    }
    const result = setOverride(state, input.rootKey, input.name, input.enabled)
    if (result.changed) {
      state = result.state
      saveState(settings.dshHome, state)
      invalidate()
      log(
        input.enabled ? 'policy-enable' : 'policy-disable',
        `${input.enabled ? '启用' : '停用'} ${input.rootKey}/${input.name}（注册表策略覆盖，源文件不变）`,
      )
    }
    return { ok: true, changed: result.changed }
  }

  return {
    settings,
    /** 注册表本身，供 `/registry` 路由读取真实裁决结果；由 `apply()` 注入。 */
    registry: null,
    get state() {
      return state
    },
    setState(next) {
      state = next
    },
    loaded,
    invalidators,
    rootsFor,
    overridesFor,
    catalogFor,
    invalidate,
    log,
    setEnabled,
    /** 供路由与工具在缺少会话上下文时使用的 cwd。 */
    get defaultCwd() {
      return defaultCwd
    },
    setDefaultCwd(cwd) {
      if (typeof cwd === 'string' && cwd.trim()) defaultCwd = cwd.trim()
    },
  }
}

/**
 * 运行时在插件上下文上的挂点。
 *
 * 同一进程里的其它插件（以及集成测试）可以用它直接调用本插件的策略接口，而不必绕
 * HTTP。绕 HTTP 不总是可行 —— 没有 Web 服务的 profile 里根本没有那条路由 —— 而直接
 * 往 `state.json` 里写则完全不做数：内存状态不会更新，注册表也不会收到失效通知，
 * 于是"改了却没人看见"。
 */
export const RUNTIME_KEY = Symbol.for('@lolkda/dsh-skills-manager/runtime')

/**
 * 取出某个上下文上挂着的本插件运行时。
 * @param {object} ctx - 插件上下文
 * @returns {object|undefined} 运行时
 */
export function runtimeOf(ctx) {
  return ctx?.[RUNTIME_KEY]
}

/**
 * cordis 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文
 * @param {object} [config] - 插件配置
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)
  runtime.registry = ctx.skills
  if (runtime.loaded.damaged) runtime.log('state-damaged', runtime.loaded.reason ?? 'state.json 无法使用，已按空状态启动')
  try {
    Object.defineProperty(ctx, RUNTIME_KEY, { value: runtime, configurable: true, enumerable: false })
  } catch {
    // 某些上下文是冻结的代理；取不到挂点只影响进程内取用，不影响插件功能。
  }

  /**
   * 在一个技能注册表上挂载我们的覆盖提供方。
   * @param {object} skills - `ctx.skills`
   * @returns {() => void} 注销函数
   */
  const registerOn = (skills) =>
    skills.registerProvider((control) => {
      invalidatorsAdd(control)
      return createProvider({ rootsFor: runtime.rootsFor, overridesFor: runtime.overridesFor })
    })

  /**
   * 登记失效回调，并在该注册被释放时移除。
   * @param {object} control - 提供方控制对象
   * @returns {void}
   */
  function invalidatorsAdd(control) {
    runtime.invalidators.add(control.invalidate)
    if (control.signal && typeof control.signal.addEventListener === 'function') {
      control.signal.addEventListener('abort', () => runtime.invalidators.delete(control.invalidate), { once: true })
    }
  }

  ctx.effect(() => registerOn(ctx.skills), 'skills-manager：宿主层覆盖提供方')
  ctx.effect(() => installAgentProviders(ctx, registerOn, (detail) => runtime.log('scope-snapshot', detail), (cwd) => runtime.catalogFor(cwd)), 'skills-manager：每个 agent 作用域的覆盖提供方')

  // 两个可选半边用 cordis 的「可用时再装」惯用法，而不是写进 `inject`：
  // 写进 `inject` 会让整个插件在缺 Web 服务的 profile（headless、SDK）里根本不挂载 ——
  // 而**启停是这个插件的核心能力，不该被 Web 半边绑死**。技能覆盖、Agent 工具在任何
  // profile 里都该能用；有没有 HTTP 路由只影响界面。
  //
  // 反过来，也不能只写 `ctx.get(...)`：那样会在服务就绪前就判定"没有"。两种写法各错一半，
  // 合起来才对 —— 先问一次，没问到就订阅，等它出现。
  const whenAvailable = (services, label, install) => {
    const ready = services.every((service) => ctx.get?.(service) !== undefined)
    if (ready) {
      ctx.effect(() => attempt(() => install(ctx), label, runtime), `skills-manager：${label}`)
      return
    }
    // 静默跳过是这个插件最贵的一次事故：路由没注册、服务端一切正常、日志一片干净，
    // 只是每个请求都 404。所以"还没就绪"必须留下痕迹。
    if (typeof ctx.inject !== 'function') {
      runtime.log('install-skipped', `${label}：缺少 ${services.join('、')} 服务，且当前上下文不支持延迟注入`)
      return
    }
    runtime.log('install-deferred', `${label}：${services.join('、')} 尚未就绪，等它出现再注册`)
    ctx.inject(services, (inner) => {
      ctx.effect(() => attempt(() => install(inner), label, runtime), `skills-manager：${label}`)
    })
  }

  whenAvailable(['webServer', 'webRuntime'], 'HTTP 路由', (inner) => {
    const webServer = inner.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return undefined
    // 路由处理器要查 `sessions` / `agents`，这些服务在根上下文上一直可用；延迟注入拿到的
    // `inner` 只保证含 webServer/webRuntime。所以给路由一个指向根上下文的查表函数。
    return installRoutes({ get: (service) => ctx.get?.(service) }, webServer, runtime)
  })

  whenAvailable(['tools'], 'Agent 工具', (inner) => {
    const tools = inner.get('tools')
    if (!tools || typeof tools.register !== 'function') return undefined
    return installTools(inner, tools, runtime)
  })
}

/**
 * 记下某个 agent 作用域里真正解析出的技能。
 *
 * 这不是调试残留，而是这个插件最该回答的问题的答案：「为什么这个会话里没有它」。宿主层的
 * 视图和会话看到的**根本不是同一份** —— 真实技能由 preset 层提供，宿主层通常是空的。所以
 * 每个 agent 一建立就把它自己那一层的裁决结果落到活动日志里：启停到底有没有作用到这个
 * 会话，看一眼日志就知道，不必去信插件自己的状态接口。
 * @param {object} registry - 根上下文上的技能注册表
 * @param {object} agent - agent 记录
 * @param {(cwd: string) => object} [catalogFor] - 按目录算出本插件自己的技能清单
 * @returns {Promise<string>} 诊断文本
 */
async function describeScope(registry, agent, catalogFor) {
  const view = await agentScopeView(registry, agent)
  if (!view.resolved) return `agent ${agent.id} 的技能视图无法解析：${view.reason}`
  const names = view.skills.map((skill) => (skill.invocation.modelInvocable ? skill.name : `${skill.name}（模型不可用）`))
  const base = `agent ${agent.id} 的技能视图：共 ${names.length} 条 —— ${names.join('、') || '（空）'}`
  // 再拿本插件自己的清单对一遍。两边不一致意味着界面与模型看到的不是一回事，而这种不一致
  // 不会自己报错 —— 只能主动比出来，趁早摆在日志里。
  if (typeof catalogFor !== 'function' || view.cwd === undefined) return base
  try {
    return `${base}；${describeDivergence(compareWithRegistry(catalogFor(view.cwd), view.skills))}`
  } catch (error) {
    return `${base}；目录比对失败：${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * 执行一个可选半边的安装，失败时只记录并降级。
 *
 * 这不是防御性编程的空话：本插件第一次真机启动就因为在 `ctx.tools.register` 的校验里
 * 漏了一个必需字段，让**整个 profile 的插件树加载失败、DSH 无法启动**。一个设置页里的
 * 小工具绝不该有这种失败模式，所以路由与工具这两块各自兜错 —— 出错的那部分降级，
 * 其余部分照常工作，DSH 照常启动。
 * @param {() => ((() => void)|void)} install - 安装函数
 * @param {string} label - 失败信息里的部件名
 * @param {object} runtime - 运行时，用于写日志
 * @returns {() => void} 注销函数
 */
function attempt(install, label, runtime) {
  try {
    const dispose = install()
    return typeof dispose === 'function' ? dispose : () => {}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    runtime.log('install-failed', `${label}安装失败，该部分已停用：${message}`)
    console.error(`[dsh-skills-manager] ${label}安装失败，该部分已停用：${message}`)
    return () => {}
  }
}

/**
 * 为每个现存与后续创建的 agent，在其作用域里再注册一份覆盖提供方。
 *
 * 这就是「preset 层遮蔽」的解法：只有注册进 agent 自己的层，我们的候选才和 preset
 * 挂载的 `dsh-skill-filesystem` 处在同一层，rank 0 才能在裁决里胜出。
 * @param {object} ctx - 上下文
 * @param {(skills: object) => () => void} registerOn - 注册函数
 * @param {(detail: string) => void} [log] - 诊断日志
 * @param {(cwd: string) => object} [catalogFor] - 按目录算出本插件自己的技能清单，用于比对
 * @returns {() => void} 组合注销函数
 */
export function installAgentProviders(ctx, registerOn, log, catalogFor) {
  if (typeof ctx.on !== 'function') return () => {}
  const disposers = new Map()
  const install = (agent) => {
    if (!agent || typeof agent.id !== 'string' || disposers.has(agent.id)) return
    const agentCtx = agent.ctx
    const skills = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx?.skills
    if (!skills || typeof skills.registerProvider !== 'function') return
    try {
      disposers.set(agent.id, registerOn(skills))
      if (log) describeScope(ctx.get?.('skills') ?? ctx.skills, agent, catalogFor).then(log, () => {})
    } catch {
      // agent 正在销毁、或它的技能服务已不可用；跳过它，不影响其它 agent。
    }
  }
  const uninstall = (agent) => {
    if (!agent) return
    const dispose = disposers.get(agent.id)
    disposers.delete(agent.id)
    if (typeof dispose === 'function') dispose()
  }
  const stopCreated = ctx.on('agent/created', ({ agent }) => install(agent))
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => uninstall(agent))
  const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
  if (agents && typeof agents.list === 'function') {
    for (const agent of agents.list()) install(agent)
  }
  return () => {
    if (typeof stopCreated === 'function') stopCreated()
    if (typeof stopDisposed === 'function') stopDisposed()
    for (const dispose of disposers.values()) if (typeof dispose === 'function') dispose()
    disposers.clear()
  }
}

export { PROVIDER_NAME, ROUTE_PREFIX, OVERLAY_RANK, emptyState }

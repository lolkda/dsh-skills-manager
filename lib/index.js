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
import { createProvider, PROVIDER_NAME } from './provider.js'
import { installRoutes, ROUTE_PREFIX } from './routes.js'
import { OVERLAY_RANK, listRoots, resolveAgentsHome, resolveDshHome } from './roots.js'
import { appendLog, emptyState, loadState, saveState, setOverride } from './store.js'
import { installTools } from './tools.js'

/** cordis 插件名，同时是 profile 里那一行的 id 来源。 */
export const name = 'dsh-skills-manager'

/**
 * 依赖清单必须**声明式**写全，不能只声明 `skills` 然后在 `apply` 里用 `ctx.get()` 去捞。
 *
 * 这是真机踩出来的坑：cordis 只等它声明过的服务。曾经这里只写 `['skills']`，于是本插件
 * 会在 `webServer` 就绪**之前**就被挂载，`ctx.get('webServer')` 拿到 undefined，路由静默
 * 地从未注册 —— 服务端一切正常、日志一片干净，只是所有请求 404。机会式取服务必须配合
 * 声明式等待，否则「可选依赖」会变成「永远拿不到」。
 *
 * 清单与 `@michengai/dsh-skills-manager` 一致：那份清单在同一个 profile 上已被证明可用。
 */
export const inject = ['webServer', 'webRuntime', 'skills', 'tools', 'sessions']

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
 * cordis 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 上下文
 * @param {object} [config] - 插件配置
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const runtime = createRuntime(config)
  runtime.registry = ctx.skills
  if (runtime.loaded.damaged) runtime.log('state-damaged', runtime.loaded.reason ?? 'state.json 无法使用，已按空状态启动')

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
  ctx.effect(() => installAgentProviders(ctx, registerOn), 'skills-manager：每个 agent 作用域的覆盖提供方')

  // 两个可选半边：可用就装，不可用就**写一条日志说清楚**。静默跳过是这个插件最贵的
  // 一次事故 —— 路由没注册、服务端一切正常、日志一片干净，只是每个请求都 404。
  const webServer = ctx.get?.('webServer')
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        attempt(() => installRoutes(ctx, webServer, runtime), 'HTTP 路由', runtime, (dispose) => {
          runtime.log('routes-mounted', `HTTP 路由已注册到 ${ROUTE_PREFIX}`)
          return dispose
        }),
      'skills-manager：HTTP 路由',
    )
  } else {
    runtime.log('routes-missing', 'webServer 服务不可用，HTTP 路由未注册；界面将拿不到数据')
  }

  const tools = ctx.get?.('tools')
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => attempt(() => installTools(ctx, tools, runtime), 'Agent 工具', runtime), 'skills-manager：Agent 工具')
  } else {
    runtime.log('tools-missing', 'tools 服务不可用，Agent 工具未注册')
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
 * @param {(dispose: () => void) => (() => void)} [onSuccess] - 成功后的包装，可用于记录诊断
 * @returns {() => void} 注销函数
 */
function attempt(install, label, runtime, onSuccess) {
  try {
    const dispose = install()
    const settle = typeof dispose === 'function' ? dispose : () => {}
    return typeof onSuccess === 'function' ? onSuccess(settle) : settle
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
 * @returns {() => void} 组合注销函数
 */
export function installAgentProviders(ctx, registerOn) {
  if (typeof ctx.on !== 'function') return () => {}
  const disposers = new Map()
  const install = (agent) => {
    if (!agent || typeof agent.id !== 'string' || disposers.has(agent.id)) return
    const agentCtx = agent.ctx
    const skills = agentCtx && typeof agentCtx.get === 'function' ? agentCtx.get('skills') : agentCtx?.skills
    if (!skills || typeof skills.registerProvider !== 'function') return
    try {
      disposers.set(agent.id, registerOn(skills))
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

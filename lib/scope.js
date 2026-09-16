/**
 * 作用域读取：搞清「某个 agent 真正看到哪些技能」。
 *
 * 这里有一个容易致命的不对称，写代码时几乎必然踩一次：
 *
 *   - **写**（`registerProvider`）从调用上下文推断作用域 —— `scopeOf(this.ctx)`；
 *   - **读**（`snapshot` / `get`）**只**看 `options.scope`，不从上下文推断。
 *
 * 于是「从 agent 的 ctx 上调 `snapshot({})`」看起来天经地义，实际读到的是 global 层。
 * 在真实部署里 global 层通常**一条技能都没有**（技能由 preset 层提供），所以这个错误
 * 表现为「界面显示得对、注册表查询却是空的」，非常容易被误判成没有技能。
 *
 * 因此读 agent 的视图必须把它的作用域 key 显式传进去。
 *
 * 关于怎么拿到那个 key：`@deepseek-ai/dsh-scope` 用的是模块私有的
 * `Symbol("dsh.scope")`（不是 `Symbol.for`），所以从本包 `import` 进来再 `scopeOf(ctx)`
 * 在 profile 里可能拿到另一个模块实例、返回 `undefined`。直接从上下文对象上按符号描述
 * 取，则与模块实例无关，也不会给本插件增加一个对内部包的直接依赖。
 */

/** 上游用于标记作用域的符号描述。 */
const SCOPE_TAG = 'dsh.scope'

/**
 * 读出一个上下文所继承的作用域 key。
 * @param {object} ctx - 上下文（agent 的 ctx）
 * @returns {object|undefined} 作用域 key；未标记时为 undefined
 */
export function scopeKeyOf(ctx) {
  if (!ctx || (typeof ctx !== 'object' && typeof ctx !== 'function')) return undefined
  let current = ctx
  // 作用域标记可能落在原型链上（"nearest scope tag inherited by a context"），所以逐级上溯。
  while (current !== null && current !== undefined) {
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      if (symbol.description === SCOPE_TAG) return current[symbol]
    }
    current = Object.getPrototypeOf(current)
  }
  return undefined
}

/**
 * 取一个 agent 自己的工作目录。
 *
 * 必须用 **agent 的** cwd，而不是请求里带的、也不是进程的：项目级根（`.dsh/skills`、
 * `.agents/skills`）是从会话的工作目录往上找 `.git` 得到的，用别的目录会解析出另一套项目根。
 * `dsh-tool-skill` 用的就是 `agent.session.header.cwd`，这里与它保持一致。
 * @param {object} agent - agent 记录
 * @returns {string|undefined} cwd
 */
export function agentCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() ? cwd.trim() : undefined
}

/**
 * 读一个 agent 所在层解析出的技能视图。
 * @param {object} registry - 根上下文上的技能注册表
 * @param {object} agent - agent 记录
 * @param {object} [options] - 额外传给 snapshot 的选项（如 `cwd`）
 * @returns {Promise<{ resolved: boolean, reason?: string, skills?: object[], complete?: boolean }>} 视图
 */
export async function agentScopeView(registry, agent, options = {}) {
  const skills = registry ?? agent?.ctx?.get?.('skills')
  if (!skills || typeof skills.snapshot !== 'function') return { resolved: false, reason: '注册表不可用' }
  const scope = scopeKeyOf(agent?.ctx)
  if (scope === undefined) {
    return { resolved: false, reason: '无法从 agent 上下文读出作用域标识；不做猜测，以免报出 global 层的空结果' }
  }
  // 优先用 agent 自己的 cwd；拿不到时才退回调用方给的。缺了 cwd 不会报错，只会**少掉项目级根**
  // —— 一个不报错的漏报，正是这轮踩到的坑，所以顺序不能反。
  const cwd = agentCwd(agent) ?? options.cwd
  const snapshot = await skills.snapshot({ ...options, ...(cwd === undefined ? {} : { cwd }), scope })
  return { resolved: true, complete: snapshot.complete, skills: snapshot.skills, cwd }
}

/**
 * 把一次 snapshot 收敛成可比较的摘要。
 * @param {object} snapshot - `snapshot()` 的返回值
 * @returns {object} 摘要
 */
export function summarizeSnapshot(snapshot) {
  return {
    complete: snapshot.complete,
    skills: snapshot.skills.map((skill) => ({
      name: skill.name,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
      provider: skill.provider,
      source: skill.source,
      fromThisPlugin: skill.provider === 'dsh-skills-manager',
    })),
  }
}

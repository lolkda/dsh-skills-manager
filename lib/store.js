/**
 * 插件状态：`$DSH_HOME/dsh-skills-manager/state.json`。
 *
 * 状态里**只存显式覆盖**，不存任何从磁盘推导出来的东西 —— 目录内容是文件系统的投影，
 * 一旦缓存就会和真实文件不一致，而「显示的和实际加载的不是同一个东西」正是这类工具
 * 最常见的谎。因此这里没有 revision、没有 digest、没有缓存表。
 *
 * 覆盖按 `rootKey → 技能名 → { enabled }` 存。把 rootKey 编进键是必要的：同名技能
 * 可以同时存在于 `~/.dsh/skills` 和某个项目的 `.dsh/skills`，它们是两个不同的东西。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 状态文件格式版本。读取到不认识的版本时按「无状态」处理，而不是猜测字段含义。 */
export const STATE_VERSION = 1

/** 单条日志超过该字节数就轮转一次，避免长期运行把盘写满。 */
const MAX_LOG_BYTES = 1 << 20

/** 覆盖值：显式启用、显式停用。 */
export const ENABLED = true
export const DISABLED = false

/**
 * 状态目录。
 *
 * 用自己的插件名而不是裸的 `skills-manager`：`$DSH_HOME/skills-manager/` 已经被
 * `@michengai/dsh-skills-manager` 占用，两边同名同路径，先写入的一方会悄悄覆盖另一方
 * 的设置 —— 在替换期并存时这会直接毁掉用户已有的启停配置。
 * @param {string} dshHome - Harness 配置根
 * @returns {string} `$DSH_HOME/dsh-skills-manager`
 */
export function storeDir(dshHome) {
  return join(dshHome, 'dsh-skills-manager')
}

/**
 * 状态文件路径。
 * @param {string} dshHome - Harness 配置根
 * @returns {string} state.json 路径
 */
export function statePath(dshHome) {
  return join(storeDir(dshHome), 'state.json')
}

/**
 * 活动日志路径，放在状态目录里，同样避开别人占用的文件名。
 * @param {string} dshHome - Harness 配置根
 * @returns {string} JSONL 日志路径
 */
export function logPath(dshHome) {
  return join(storeDir(dshHome), 'dsh-skills-manager.log')
}

/**
 * 生成一份空状态。
 * @returns {{ version: number, overrides: Record<string, Record<string, { enabled: boolean }>> }}
 */
export function emptyState() {
  return { version: STATE_VERSION, overrides: {} }
}

/**
 * 读取状态。
 *
 * 任何读取问题（文件缺失、损坏、版本不认识）都退回空状态并**在返回值里说明原因**，
 * 而不是抛错：一个坏掉的 state.json 不该让整个插件挂载失败，那会让用户连修它的
 * 界面都打不开。
 * @param {string} dshHome - Harness 配置根
 * @returns {{ state: object, damaged: boolean, reason?: string }}
 */
export function loadState(dshHome) {
  const file = statePath(dshHome)
  if (!existsSync(file)) return { state: emptyState(), damaged: false }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { state: emptyState(), damaged: true, reason: `无法读取 state.json：${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: emptyState(), damaged: true, reason: 'state.json 不是合法 JSON，已按空状态启动（原文件未被覆盖）' }
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) {
    return { state: emptyState(), damaged: true, reason: `state.json 的 version 不是 ${STATE_VERSION}，已按空状态启动` }
  }
  return { state: normalizeState(parsed), damaged: false }
}

/**
 * 把解析出来的对象收敛成规范形态，丢弃一切形状不对的内容。
 * @param {object} parsed - JSON 解析结果
 * @returns {object} 规范状态
 */
export function normalizeState(parsed) {
  const state = emptyState()
  const overrides = parsed.overrides
  if (!overrides || typeof overrides !== 'object') return state
  for (const [rootKey, values] of Object.entries(overrides)) {
    if (!rootKey || !values || typeof values !== 'object') continue
    for (const [name, entry] of Object.entries(values)) {
      if (!name || !entry || typeof entry !== 'object') continue
      if (entry.enabled !== true && entry.enabled !== false) continue
      state.overrides[rootKey] ??= {}
      state.overrides[rootKey][name] = { enabled: entry.enabled }
    }
  }
  return state
}

/**
 * 原子写入状态。
 *
 * 先写同目录临时文件再 rename：直接覆写时进程被杀会留下半个 JSON，而半个 JSON 会被
 * 上面的 loadState 判为损坏、静默丢掉用户全部覆盖。
 * @param {string} dshHome - Harness 配置根
 * @param {object} state - 要写入的状态
 * @returns {void}
 */
export function saveState(dshHome, state) {
  const dir = storeDir(dshHome)
  mkdirSync(dir, { recursive: true })
  const target = statePath(dshHome)
  const temp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  try {
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * 取某条覆盖。
 * @param {object} state - 状态
 * @param {string} rootKey - 根 key
 * @param {string} name - 技能名
 * @returns {boolean|undefined} `true` 显式启用、`false` 显式停用、`undefined` 无覆盖
 */
export function overrideFor(state, rootKey, name) {
  const entry = state.overrides[rootKey]?.[name]
  return entry ? entry.enabled : undefined
}

/**
 * 写入或清除一条覆盖，返回**新**状态对象。
 *
 * 函数式返回是为了让调用方能在一次同步块里算出新状态、先持久化、再让提供方失效 ——
 * 顺序反了会出现「已经生效但重启就没了」或「已经写盘但这一步还是旧策略」。
 * @param {object} state - 原状态
 * @param {string} rootKey - 根 key
 * @param {string} name - 技能名
 * @param {boolean|null} enabled - `true`/`false` 设定，`null` 清除该条覆盖
 * @returns {{ state: object, changed: boolean }} 新状态与是否真的变了
 */
export function setOverride(state, rootKey, name, enabled) {
  const current = overrideFor(state, rootKey, name)
  if (enabled === null) {
    if (current === undefined) return { state, changed: false }
    const next = cloneState(state)
    delete next.overrides[rootKey][name]
    if (Object.keys(next.overrides[rootKey]).length === 0) delete next.overrides[rootKey]
    return { state: next, changed: true }
  }
  if (current === enabled) return { state, changed: false }
  const next = cloneState(state)
  next.overrides[rootKey] ??= {}
  next.overrides[rootKey][name] = { enabled: enabled === ENABLED }
  return { state: next, changed: true }
}

/**
 * 深拷贝状态。
 * @param {object} state - 原状态
 * @returns {object} 副本
 */
export function cloneState(state) {
  const overrides = {}
  for (const [rootKey, values] of Object.entries(state.overrides)) {
    overrides[rootKey] = { ...values }
  }
  return { version: STATE_VERSION, overrides }
}

/**
 * 丢弃指向已不存在根 key 的覆盖。
 *
 * 只清理「根 key 本身已经不再出现在任何已知根里」的条目。项目级根会随项目出现与消失，
 * 在这里删掉它们等于把用户在那个项目里的设置删掉，所以调用方只应传入长期根 key。
 * @param {object} state - 原状态
 * @param {Set<string>} knownRootKeys - 当前已知的长期根 key
 * @returns {{ state: object, changed: boolean, dropped: string[] }}
 */
export function pruneOverrides(state, knownRootKeys) {
  const dropped = []
  const next = cloneState(state)
  for (const rootKey of Object.keys(next.overrides)) {
    if (knownRootKeys.has(rootKey)) continue
    dropped.push(rootKey)
    delete next.overrides[rootKey]
  }
  return { state: next, changed: dropped.length > 0, dropped }
}

/**
 * 追加一条活动日志。
 *
 * 写日志失败**绝不能**影响主流程：日志是给人看的旁证，不是功能的一部分。
 * @param {string} dshHome - Harness 配置根
 * @param {string} event - 事件名
 * @param {string} detail - 人类可读细节
 * @returns {void}
 */
export function appendLog(dshHome, event, detail) {
  try {
    const file = logPath(dshHome)
    mkdirSync(dirname(file), { recursive: true })
    const info = statSync(file, { throwIfNoEntry: false })
    if (info && info.size >= MAX_LOG_BYTES) {
      rmSync(`${file}.1`, { force: true })
      renameSync(file, `${file}.1`)
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), event, detail })}\n`, 'utf8')
  } catch {
    // 有意吞掉：日志不可写不应让任何操作失败。
  }
}

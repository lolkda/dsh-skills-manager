/**
 * DSH 技能根目录的发现与扫描。
 *
 * 这里是本插件「管理哪些目录」的唯一真源，与 `@deepseek-ai/dsh-skill-filesystem`
 * 的默认根集合逐条对齐（rank 也一样），因为我们的策略覆盖必须落在**文件系统提供方
 * 真正会读到的那些 skill 名**上 —— 少扫一个根，那个根下的技能就永远停用不掉。
 *
 * 根目录的 key 会被持久化进 state.json，因此它必须**跨进程稳定**：
 *  - 用户级根用固定 key（`dsh`、`agents`）；
 *  - 项目级根把项目绝对路径编进 key（`project-dsh@F:/project/foo`），否则在 A 项目
 *    里停用的技能会在 B 项目里也显示为停用 —— 那是错的，两个项目各有各的 skill。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 与 `dsh-skill-filesystem` 一致的 rank；数字小者赢得同层重名。 */
export const RANK = Object.freeze({
  projectDsh: 100,
  projectAgents: 200,
  custom: 300,
  userDsh: 400,
  userAgents: 500,
  bundled: 600,
})

/** 我们会施加覆盖的最低位 rank：低于文件系统提供方的全部 rank，保证同层必胜。 */
export const OVERLAY_RANK = 0

/**
 * 解析 Harness 配置根。
 * @param {NodeJS.ProcessEnv} env - 环境变量
 * @returns {string} `$DSH_HOME` 或 `~/.dsh`
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return configured ? resolve(configured) : join(homedir(), '.dsh')
}

/**
 * 解析共享 agent 配置根。
 * @param {NodeJS.ProcessEnv} env - 环境变量
 * @returns {string} `$DSH_AGENTS_HOME` 或 `~/.agents`
 */
export function resolveAgentsHome(env = process.env) {
  const configured = typeof env.DSH_AGENTS_HOME === 'string' ? env.DSH_AGENTS_HOME.trim() : ''
  return configured ? resolve(configured) : join(homedir(), '.agents')
}

/**
 * 从 cwd 向上寻找最近的项目根。
 *
 * 项目根的定义与 DSH 相同：最近的、包含 `.git` 的祖先目录；都不含时退回 cwd 本身。
 * @param {string} cwd - 会话工作目录
 * @param {(path: string) => boolean} [isFile] - 判定 `.git` 存在的谓词，测试用
 * @returns {string} 项目根绝对路径
 */
export function findProjectRoot(cwd, isFile = existsSync) {
  let current = resolve(cwd)
  for (;;) {
    if (isFile(join(current, '.git'))) return current
    const parent = resolve(current, '..')
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * 把一个绝对路径规范化成 state.json 里可用的稳定标识。
 *
 * Windows 路径大小写不敏感，且反斜杠与正斜杠混用，直接当 key 会产生同一目录的多个
 * 条目 —— 于是同一处覆盖会时而生效时而失效。
 * @param {string} path - 绝对路径
 * @returns {string} 规范化标识
 */
export function pathIdentity(path) {
  const normalized = resolve(path).replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/**
 * 列出本次查找要扫描的全部技能根。
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, config?: object }} [options] - 查找上下文
 * @returns {Array<{ key: string, source: string, rank: number, path: string, scope: string, mutable: boolean, exists: boolean }>}
 *   按 rank 升序排列的根定义
 */
export function listRoots(options = {}) {
  const env = options.env ?? process.env
  const config = options.config ?? {}
  const cwd = typeof options.cwd === 'string' && options.cwd.trim() ? resolve(options.cwd.trim()) : process.cwd()
  const dshHome = config.dshHome ? resolve(config.dshHome) : resolveDshHome(env)
  const agentsHome = config.agentsHome ? resolve(config.agentsHome) : resolveAgentsHome(env)
  const roots = []
  const seen = new Set()

  /**
   * 追加一个根，跳过与已有根指向同一目录的重复项。
   * @param {object} root - 根定义
   */
  const push = (root) => {
    const identity = pathIdentity(root.path)
    if (seen.has(identity)) return
    seen.add(identity)
    roots.push({ ...root, exists: existsSync(root.path) })
  }

  if (config.includeDefaultRoots !== false) {
    const projectRoot = findProjectRoot(cwd)
    const projectId = pathIdentity(projectRoot)
    push({
      key: `project-dsh@${projectId}`,
      source: 'project-dsh',
      rank: RANK.projectDsh,
      path: join(projectRoot, '.dsh', 'skills'),
      scope: 'project',
      mutable: true,
    })
    push({
      key: `project-agents@${projectId}`,
      source: 'project-agents',
      rank: RANK.projectAgents,
      path: join(projectRoot, '.agents', 'skills'),
      scope: 'project',
      mutable: true,
    })
  }

  for (const dir of normalizeCustomDirs(config.customSkillDirs)) {
    push({
      key: `custom@${pathIdentity(dir)}`,
      source: 'custom',
      rank: RANK.custom,
      path: resolve(dir),
      scope: 'user',
      mutable: true,
    })
  }

  if (config.includeDefaultRoots !== false) {
    push({ key: 'dsh', source: 'user-dsh', rank: RANK.userDsh, path: join(dshHome, 'skills'), scope: 'user', mutable: true })
    push({
      key: 'agents',
      source: 'user-agents',
      rank: RANK.userAgents,
      path: join(agentsHome, 'skills'),
      scope: 'user',
      mutable: true,
    })
  }

  const bundled = config.bundledSkillDir ?? (config.includeDefaultRoots !== false ? env.DSH_BUNDLED_SKILL_DIR : undefined)
  if (typeof bundled === 'string' && bundled.trim()) {
    // bundled 根属于安装内容，删改会被升级覆盖，因此标记为只读：UI 只允许查看与停用。
    push({ key: 'bundled', source: 'bundled', rank: RANK.bundled, path: resolve(bundled.trim()), scope: 'user', mutable: false })
  }

  return roots.sort((a, b) => a.rank - b.rank)
}

/**
 * 把自定义目录配置收敛成字符串数组。
 * @param {unknown} value - 配置值
 * @returns {string[]} 非空目录列表
 */
function normalizeCustomDirs(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
}

/**
 * 扫描一个根的直接子项，找出技能条目。
 *
 * 只识别 `<root>/<name>/SKILL.md` 与 `<root>/<name>.md` 两种形态并深入到**一层** ——
 * 这与 `dsh-skill-filesystem` 一致。刻意不递归：递归扫描会找出注册表根本不会加载的
 * 文件，把它们列进 UI 只会让「为什么这个技能不生效」更难回答。
 * @param {object} root - `listRoots` 返回的根定义
 * @returns {{ entries: Array<{ entryName: string, kind: string, docPath: string }>, diagnostics: Array<object> }}
 */
export function scanRoot(root) {
  const entries = []
  const diagnostics = []
  if (!existsSync(root.path)) return { entries, diagnostics }

  let dirents
  try {
    dirents = readdirSync(root.path, { withFileTypes: true })
  } catch (error) {
    diagnostics.push({ level: 'error', code: 'root.unreadable', message: `无法读取目录：${error instanceof Error ? error.message : String(error)}` })
    return { entries, diagnostics }
  }

  // 原生提供方按完整目录项名排序，不能先去掉 .md 再排序。
  dirents.sort((a, b) => a.name.localeCompare(b.name))
  for (const dirent of dirents) {
    const entryName = dirent.name
    // 隐藏项一律跳过：`.system`（DSH 内置技能存放处）必须不可见，其余点目录也不该是技能。
    if (entryName.startsWith('.')) continue
    const entryPath = join(root.path, entryName)
    if (dirent.isDirectory()) {
      const docPath = join(entryPath, 'SKILL.md')
      if (isFile(docPath)) entries.push({ entryName, kind: 'bundle', docPath })
      continue
    }
    if (!dirent.isFile()) continue
    if (!/\.md$/i.test(entryName)) continue
    entries.push({ entryName: entryName.replace(/\.md$/i, ''), kind: 'flat', docPath: entryPath })
  }

  return { entries, diagnostics }
}

/**
 * 校验一个来自外部的根 key 的基本形状。
 *
 * 这只是**形状**校验，不是授权：调用方必须再拿它去 `listRoots()` 的结果里查表，
 * 只有查到的根才能被操作。把外部字符串直接拼进文件路径是本插件最容易被滥用的
 * 地方，查表是真防线，这个函数只是让明显畸形的输入早点失败。
 * @param {unknown} value - 请求里带来的 key
 * @returns {string} 通过形状校验的 key，否则空串
 */
export function normalizeRootKey(value) {
  if (typeof value !== 'string') return ''
  const key = value.trim()
  if (!key || key.length > 4096) return ''
  // key 包含真实路径，中文和空格合法；授权仍由 rootsFor 查表负责。
  return /[\u0000-\u001f\u007f]/u.test(key) ? '' : key
}

/**
 * 判断路径是否是一个存在的普通文件。
 * @param {string} path - 待判定路径
 * @returns {boolean} 是否为普通文件
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

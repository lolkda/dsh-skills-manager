/**
 * 把「磁盘上的根目录」与「state.json 里的覆盖」合成一份目录视图。
 *
 * 这是本插件的判定中枢，被 HTTP 路由、Agent 工具和覆盖提供方三方共用 —— 三者看到的
 * 「这个技能现在到底可不可用」必须是同一份计算，否则界面说停用、模型却还能加载。
 *
 * 重名裁决与注册表一致：**同层内 rank 小者胜**。本插件只管理同一个宿主层里的这些根，
 * 所以一层内的裁决规则就是全部规则。被压掉的同名项不会消失，而是标 `shadowed` 并
 * 保留在选择列表里 —— 「为什么我停用的那个技能还在」通常正是因为它被另一个根的同名
 * 技能压住了，把这个关系显示出来比隐藏它有用。
 */

import { readFileSync } from 'node:fs'

import { readSkillDocument } from './frontmatter.js'
import { scanRoot } from './roots.js'

/**
 * 读取文件内容，失败返回 undefined。
 *
 * 技能文件可能是二进制/编码损坏、被其他进程锁住、或在这一刻被删掉；这些都不该让
 * 整个目录接口 500，它们只是这条技能本轮不可读。
 * @param {string} path - 文件路径
 * @returns {string|undefined} 文本内容
 */
export function defaultReadFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * 生成完整目录视图。
 * @param {{
 *   roots: Array<object>,
 *   overrides?: Record<string, Record<string, { enabled: boolean }>>,
 *   readFile?: (path: string) => string|undefined
 * }} options - 输入
 * @returns {{
 *   roots: Array<object>,
 *   skills: Array<object>,
 *   diagnostics: Array<object>,
 *   winners: Map<string, object>
 * }} 目录视图
 */
export function buildCatalog(options) {
  const roots = Array.isArray(options.roots) ? options.roots : []
  const overrides = options.overrides ?? {}
  const readFile = options.readFile ?? defaultReadFile
  const diagnostics = []
  // 旧版位置键缺少目录身份，不能按当前顺序猜测迁移。只诊断，保留原状态。
  for (const rootKey of Object.keys(overrides)) {
    if (/^custom-[0-9]+$/.test(rootKey)) diagnostics.push({
      level: 'warn', code: 'override.legacyCustom', rootKey, source: 'custom',
      message: `旧版覆盖 ${rootKey} 没有目录路径身份，已保留但不应用；请确认原目录后重新设置启停。`,
    })
  }
  const rootViews = []
  const all = []

  for (const root of roots) {
    const { entries, diagnostics: scanDiagnostics } = scanRoot(root)
    for (const item of scanDiagnostics) diagnostics.push({ ...item, rootKey: root.key, source: root.source })
    const skills = entries.map((entry) => recordFor(root, entry, readFile))
    rootViews.push({ ...root, skills })
    for (const record of skills) {
      all.push(record)
      for (const item of record.diagnostics) {
        diagnostics.push({ ...item, rootKey: root.key, source: root.source, skill: record.name })
      }
    }
  }

  const groups = new Map()
  for (const record of all) {
    const bucket = groups.get(record.name)
    if (bucket) bucket.push(record)
    else groups.set(record.name, [record])
  }

  const winners = new Map()
  for (const [name, group] of groups) {
    group.sort(compareRank)
    // 仲裁只在**可加载**的候选之间进行。DSH 的注册表看不到解析失败的技能，所以一条
    // frontmatter 坏掉的技能不能让位于它后面的同名技能「输掉」—— 那会让界面显示一条
    // 根本不存在的生效技能，同时把真正会被加载的那条标成"被遮蔽"。
    const candidates = group.filter((record) => record.loadable !== false)
    const winner = candidates[0]
    if (winner) {
      winner.winner = true
      winners.set(name, winner)
    }
    for (const record of group) {
      if (winner !== undefined && record !== winner) record.shadowed = true
      record.override = overrideValue(overrides, record.rootKey, name)
    }
    // 只有胜出根的覆盖才算数：对一个被遮蔽的根设置覆盖，用户会以为生效了，
    // 所以这里不但不应用它，还要把这件事作为诊断报出去。
    const effectiveOverride = winner?.override
    for (const record of group) {
      if (winner !== undefined && record !== winner && hasOverride(record.override)) {
        record.overrideShadowed = true
        diagnostics.push({
          level: 'warn',
          code: 'override.shadowed',
          rootKey: record.rootKey,
          source: record.source,
          skill: name,
          message: `这条技能被 ${winner.source}（rank ${winner.rank}）的同名技能遮蔽，对它设置的启停不会生效；请改为操作 ${winner.source} 下的同名技能`,
        })
      }
      const modelInvocable = record === winner && hasOverride(effectiveOverride) ? effectiveOverride : record.fileModelInvocable
      const userInvocable = record === winner && hasOverride(effectiveOverride) ? effectiveOverride : record.fileUserInvocable
      record.effectiveModelInvocable = modelInvocable
      record.effectiveUserInvocable = userInvocable
      record.enabled = modelInvocable && userInvocable
    }
  }

  const skills = [...all].sort((a, b) => a.name.localeCompare(b.name) || a.rank - b.rank)
  return { roots: rootViews, skills, diagnostics, winners }
}

/**
 * 构造一条技能记录。
 * @param {object} root - 根定义
 * @param {{ entryName: string, kind: string, docPath: string }} entry - 扫描出的条目
 * @param {(path: string) => string|undefined} readFile - 文件读取
 * @returns {object} 技能记录
 */
function recordFor(root, entry, readFile) {
  const text = readFile(entry.docPath)
  if (text === undefined) {
    return base(root, entry, {
      description: '',
      loadable: false,
      diagnostics: [{ level: 'error', code: 'skill.unreadable', message: '无法读取技能文件（被占用、已删除或不是文本）' }],
    })
  }
  const doc = readSkillDocument(text)
  const declaredName = doc.name
  const name = declaredName && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(declaredName) ? declaredName : entry.entryName
  return {
    ...base(root, entry, { description: doc.description, loadable: doc.loadable, diagnostics: doc.diagnostics }),
    name,
    declaredName,
    whenToUse: doc.whenToUse,
    fileModelInvocable: doc.modelInvocable,
    fileUserInvocable: doc.userInvocable,
    invocationPolicyValid: doc.invocationPolicyValid,
    hasFrontmatter: doc.hasFrontmatter,
  }
}

/**
 * 记录中与文档解析无关的那部分。
 * @param {object} root - 根定义
 * @param {object} entry - 扫描条目
 * @param {object} extra - 文档解析结果
 * @returns {object} 部分记录
 */
function base(root, entry, extra) {
  return {
    name: entry.entryName,
    declaredName: '',
    entryName: entry.entryName,
    kind: entry.kind,
    docPath: entry.docPath,
    rootKey: root.key,
    source: root.source,
    scope: root.scope,
    rank: root.rank,
    mutable: root.mutable !== false,
    whenToUse: undefined,
    fileModelInvocable: true,
    fileUserInvocable: true,
    invocationPolicyValid: true,
    hasFrontmatter: false,
    override: null,
    overrideShadowed: false,
    winner: false,
    shadowed: false,
    effectiveModelInvocable: true,
    effectiveUserInvocable: true,
    enabled: true,
    ...extra,
  }
}

/**
 * 记录里是否带有效覆盖。
 *
 * `null` 与 `undefined` 都表示「没有覆盖」，但覆盖值本身可以是 `false` ——
 * 用真值判断会把「显式停用」当成「没设置」，那正好是最不该出错的一格。
 * @param {unknown} value - 覆盖值
 * @returns {boolean} 是否为有效覆盖
 */
function hasOverride(value) {
  return value === true || value === false
}

/**
 * 读取某条覆盖。
 * @param {object} overrides - 覆盖表
 * @param {string} rootKey - 根 key
 * @param {string} name - 技能名
 * @returns {boolean|null} 覆盖值，或 null 表示无覆盖
 */
function overrideValue(overrides, rootKey, name) {
  const entry = overrides?.[rootKey]?.[name]
  if (!entry) return null
  return entry.enabled === true
}

/**
 * 重名裁决排序：rank 小者在前，同 rank 保留提供方内的发现顺序。
 * @param {object} a - 记录
 * @param {object} b - 记录
 * @returns {number} 排序值
 */
function compareRank(a, b) {
  // stable sort 保留根配置顺序及各根内的原生目录项顺序。
  return a.rank - b.rank
}

/**
 * 这条记录能不能变成一个**合法的**注册表候选。
 *
 * 注册表会拿候选的 `description` 做非空校验，不合法就抛 —— 而提供方抛异常会让整次快照
 * 降级成**空清单**。也就是说：只要有一条候选不合法，模型会一条技能都拿不到。
 *
 * 所以这里守两道：
 * - `loadable`：文件读不出来（Windows 上被占用很常见）、frontmatter 有问题、描述为空的记录，
 *   注册表本来就不会加载它，没有覆盖的必要；`get()` 对这类也返回 undefined，两边保持一致。
 * - 描述非空：即便 `loadable` 为真也要再确认一次 —— 发出一条空描述的候选是**灾难级**的，
 *   不值得赌「上游一定已经拦住了」。
 * @param {object} record - 目录里的记录
 * @returns {boolean} 是否可以安全地生成候选
 */
export function canEmitCandidate(record) {
  if (record.loadable === false) return false
  if (record.invocationPolicyValid !== true) return false
  return typeof record.description === 'string' && record.description.length > 0
}

/**
 * 取目录里所有需要施加策略覆盖的条目。
 *
 * 只返回**胜出根上有覆盖**的技能：注册表按名字解析，我们的候选也是按名字遮蔽，
 * 因此覆盖必须是「名字级」的，且只能由胜出根那条记录产生。
 * @param {object} catalog - `buildCatalog` 的结果
 * @returns {Array<object>} 需要覆盖的记录
 */
export function overridesOf(catalog) {
  const result = []
  for (const winner of catalog.winners.values()) {
    if (!hasOverride(winner.override)) continue
    if (!canEmitCandidate(winner)) continue
    result.push(winner)
  }
  return result
}

/**
 * 管理实体的查找不等于策略 winner 查找：损坏或遮蔽的文档仍可修复。
 * docPath 只用于精确匹配已经扫描出的实体，绝不直接作为磁盘操作目标。
 * @param {object} catalog - 本次 roots 下的目录视图
 * @param {{rootKey?: string, name?: string, docPath?: string|null}} target - 查找条件
 * @returns {object} 唯一实体或明确的未知/歧义错误
 */
export function findCatalogDocument(catalog, target = {}) {
  const records = (catalog?.skills ?? []).filter(record => target.rootKey === undefined || record.rootKey === target.rootKey)
  let matches
  if (target.docPath !== undefined && target.docPath !== null) {
    if (typeof target.docPath !== 'string' || !target.docPath) return { ok: false, code: 'skill.invalid', error: 'docPath 必须是目录中的文档路径' }
    matches = records.filter(record => record.docPath === target.docPath)
  } else {
    if (typeof target.name !== 'string' || !target.name) return { ok: false, code: 'skill.invalid', error: '缺少技能名' }
    matches = records.filter(record => record.name === target.name)
  }
  if (matches.length === 0) return { ok: false, code: 'skill.unknown', error: `当前目录中找不到指定的技能文档：${target.name ?? ''}` }
  if (matches.length > 1) return {
    ok: false, code: 'skill.ambiguous', error: `技能 ${target.name} 对应多个文档，请在界面选择具体文件`,
    documents: matches.map(({ rootKey, docPath }) => ({ rootKey, docPath })),
  }
  return { ok: true, skill: matches[0] }
}

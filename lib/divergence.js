/**
 * 把本插件算出的技能清单与 DSH 注册表实际解析出的清单逐条比对。
 *
 * 为什么需要这个：本插件与 `dsh-skill-filesystem` 各有一份配置（`customSkillDirs`、
 * `bundledSkillDir`、甚至根目录的解析规则），两边**没有任何机制保证一致**。一旦分叉：
 *
 *   - 我们多报 → 界面上有这个技能，模型却从来收不到；
 *   - 我们少报 → 技能实际在生效，界面上却看不见，用户会以为它不存在。
 *
 * 两种都不会报错。所以只能拿注册表里的真实结果对一遍，并把差异摆到用户面前。
 *
 * 比对只取 `provider === 'filesystem'` 的那一份：本插件的 overlay 也注册在同一个注册表里，
 * 把它算进来就成了自己跟自己比。
 */

/** DSH 文件系统提供者的名字，用于把它的裁决结果从注册表快照里挑出来。 */
export const FILESYSTEM_PROVIDER = 'filesystem'

/**
 * 比对两份清单。
 * @param {object} catalog - `buildCatalog` 的结果
 * @param {object[]} registrySkills - 注册表快照里的技能
 * @returns {object} 比对结果
 */
export function compareWithRegistry(catalog, registrySkills) {
  const real = new Map()
  for (const skill of Array.isArray(registrySkills) ? registrySkills : []) {
    // 本插件自己的 overlay 也在同一个注册表里；只认文件系统那一份。
    if (skill?.provider !== FILESYSTEM_PROVIDER) continue
    if (typeof skill.name === 'string') real.set(skill.name, skill)
  }

  const ours = new Map()
  for (const record of catalog?.skills ?? []) {
    // 只有胜出且真的能加载的才算数 —— 被遮蔽的与加载失败的本就不该出现在界面上。
    // 顺带跳过 null/非对象：比对是诊断用的，不该因为一条坏数据把 `/registry` 和日志一起打挂。
    if (!record || typeof record !== 'object') continue
    if (!record.winner || record.loadable === false) continue
    if (typeof record.name !== 'string') continue
    ours.set(record.name, record)
  }

  const missing = []
  for (const name of ours.keys()) if (!real.has(name)) missing.push(name)
  const extra = []
  for (const name of real.keys()) if (!ours.has(name)) extra.push(name)

  return {
    provider: FILESYSTEM_PROVIDER,
    ours: ours.size,
    registry: real.size,
    // 只多报与只少报都要单独说清楚：两者的成因与处理方式完全不同。
    missing: missing.sort(),
    extra: extra.sort(),
    consistent: missing.length === 0 && extra.length === 0,
  }
}

/**
 * 把比对结果说成一句人话。
 * @param {object} result - `compareWithRegistry` 的结果
 * @returns {string} 描述
 */
export function describeDivergence(result) {
  if (result.consistent) return `与 DSH 实际解析一致（${result.ours} 条）`
  const parts = []
  if (result.missing.length > 0) parts.push(`本插件多报了 ${result.missing.length} 条（DSH 里没有）：${result.missing.join('、')}`)
  if (result.extra.length > 0) parts.push(`本插件少报了 ${result.extra.length} 条（DSH 里有）：${result.extra.join('、')}`)
  return parts.join('；')
}

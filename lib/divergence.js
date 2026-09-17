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
 * 比对的对象是注册表**合并之后**的结果 —— 也就是模型真正收到的那一份，所有提供方都算数。
 * 详见 `compareWithRegistry` 里的说明：这里曾经只认文件系统提供方，那会把所有被本插件
 * 覆盖过的技能都误判成"DSH 没有"。
 */

import { PROVIDER_NAME } from './provider.js'

/** DSH 文件系统提供者的名字，用于把它的裁决结果从注册表快照里挑出来。 */
export const FILESYSTEM_PROVIDER = 'filesystem'

/** 本插件覆盖提供方的名字。它接管过的技能在注册表里胜出的就是这一条，但技能本身仍在。 */
export const OVERLAY_PROVIDER = PROVIDER_NAME

/**
 * 比对两份清单。
 * @param {object} catalog - `buildCatalog` 的结果
 * @param {object[]} registrySkills - 注册表快照里的技能
 * @returns {object} 比对结果
 */
export function compareWithRegistry(catalog, registrySkills) {
  // 注册表交出来的是一份**合并之后**的结果：同一个技能名只会留下胜出的那一条。所以这里
  // 必须把**所有**提供方都算进来 —— 它不是"别人家的清单"，而是**模型真正收到的那一份**。
  //
  // 早先这里只认 `filesystem`，理由是"本插件的 overlay 也在同一个注册表里，算进来就成
  // 了自己跟自己比"。那个理由站不住：overlay 的贡献不是凭空多出一条技能，而是**同一条
  // 技能换了个胜出者**（rank 0 胜过 preset 层的 400）。把它过滤掉，得到的不是"更严格的
  // 比对"，而是把所有被覆盖过的技能都误判成"DSH 没有"。
  //
  // 真机上就是这样：用户手动启用了 7 条，界面随即报出「本插件多报了 7 条（DSH 没有，
  // 模型收不到）」，而模型一条不少地收到了。误报比不报更糟 —— 它会让这个提示彻底失去
  // 可信度，之后真出问题时没人再看它。
  //
  // 而且 overlay 也**不可能**凭空造出一条技能：`provider.js` 的 `list()` 只对覆盖表里
  // 已有、且在自己扫描结果里存在（`canEmitCandidate`）的技能发出候选，`get()` 还会在
  // 加载时重新扫描校验一遍。所以"我们自己供给的也算数"不会掩盖任何真实差异：
  // 一条技能只要能落到模型手里，它就没有"收不到"。
  const real = new Map()
  const overlaid = new Set()
  for (const skill of Array.isArray(registrySkills) ? registrySkills : []) {
    if (typeof skill?.name !== 'string') continue
    real.set(skill.name, skill)
    if (skill.provider === OVERLAY_PROVIDER) overlaid.add(skill.name)
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
    // 有多少条是被本插件的覆盖层接管的。它不影响结论，但能解释"为什么这几条不来自
    // 文件系统提供方"，免得看的人以为出了问题。
    overlaid: overlaid.size,
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
  const overlaidNote = result.overlaid > 0 ? `，其中 ${result.overlaid} 条由本插件的覆盖层接管` : ''
  if (result.consistent) return `与 DSH 实际解析一致（${result.ours} 条${overlaidNote}）`
  const parts = []
  if (result.missing.length > 0) parts.push(`本插件多报了 ${result.missing.length} 条（DSH 里没有）：${result.missing.join('、')}`)
  if (result.extra.length > 0) parts.push(`本插件少报了 ${result.extra.length} 条（DSH 里有）：${result.extra.join('、')}`)
  return parts.join('；')
}

/** 对比同一 cwd/scope 的目录名称、可观测调用策略与来源；未知字段不猜测。 */
import { PROVIDER_NAME } from './provider.js'
import { pathIdentity } from './roots.js'

export const FILESYSTEM_PROVIDER = 'filesystem'
export const OVERLAY_PROVIDER = PROVIDER_NAME

/**
 * @param {object} catalog - 管理器的目录视图
 * @param {object[]} registrySkills - 原生候选或收敛后的注册表摘要
 * @returns {object} 名称差异、策略差异、来源差异与实际核对的策略条数
 */
export function compareWithRegistry(catalog, registrySkills) {
  const real = new Map()
  const overlaid = new Set()
  for (const skill of Array.isArray(registrySkills) ? registrySkills : []) {
    if (typeof skill?.name !== 'string') continue
    real.set(skill.name, skill)
    if (skill.provider === OVERLAY_PROVIDER) overlaid.add(skill.name)
  }
  const ours = new Map()
  for (const record of catalog?.skills ?? []) {
    if (!record || !record.winner || record.loadable === false || typeof record.name !== 'string') continue
    ours.set(record.name, record)
  }
  const missing = [...ours.keys()].filter(name => !real.has(name)).sort()
  const extra = [...real.keys()].filter(name => !ours.has(name)).sort()
  const policyMismatches = []
  const sourceMismatches = []
  let checkedPolicies = 0
  for (const [name, record] of ours) {
    const actual = real.get(name)
    if (!actual) continue
    const pairs = [
      [record.effectiveModelInvocable ?? record.invocation?.modelInvocable ?? record.modelInvocable, actual.invocation?.modelInvocable ?? actual.modelInvocable],
      [record.effectiveUserInvocable ?? record.invocation?.userInvocable ?? record.userInvocable, actual.invocation?.userInvocable ?? actual.userInvocable],
    ].filter(([left, right]) => typeof left === 'boolean' && typeof right === 'boolean')
    if (pairs.length > 0) checkedPolicies++
    if (pairs.some(([left, right]) => left !== right)) policyMismatches.push(name)
    // overlay 合法接管会改变 provider，但 source/真实文档身份不应因此改变。
    const sourceDiffers = typeof record.source === 'string' && typeof actual.source === 'string' && record.source !== actual.source
    const expectedPath = record.docPath ?? record.path
    const actualPath = actual.docPath ?? actual.path
    const pathDiffers = typeof expectedPath === 'string' && typeof actualPath === 'string' && pathIdentity(expectedPath) !== pathIdentity(actualPath)
    if (sourceDiffers || pathDiffers) sourceMismatches.push(name)
  }
  return {
    provider: FILESYSTEM_PROVIDER, ours: ours.size, registry: real.size, overlaid: overlaid.size,
    missing, extra, policyMismatches: policyMismatches.sort(), sourceMismatches: sourceMismatches.sort(), checkedPolicies,
    consistent: missing.length === 0 && extra.length === 0 && policyMismatches.length === 0 && sourceMismatches.length === 0,
  }
}

/** @param {object} result - 核对结果 @returns {string} 有限证据下的结论 */
export function describeDivergence(result) {
  const overlaid = result.overlaid > 0 ? `，其中 ${result.overlaid} 条由本插件的覆盖层接管` : ''
  if (result.consistent) {
    const label = result.checkedPolicies > 0 ? '与 DSH 实际解析一致' : '与 DSH 技能名称集合一致'
    return `${label}（${result.ours} 条${overlaid}）`
  }
  const parts = []
  if (result.missing.length > 0) parts.push(`本插件多报了 ${result.missing.length} 条（DSH 里没有）：${result.missing.join('、')}`)
  if (result.extra.length > 0) parts.push(`本插件少报了 ${result.extra.length} 条（DSH 里有）：${result.extra.join('、')}`)
  if (result.policyMismatches?.length > 0) parts.push(`调用策略不一致：${result.policyMismatches.join('、')}`)
  if (result.sourceMismatches?.length > 0) parts.push(`技能来源不一致：${result.sourceMismatches.join('、')}`)
  return parts.join('；')
}

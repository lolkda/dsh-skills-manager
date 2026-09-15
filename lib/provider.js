/**
 * 覆盖提供方：把 state.json 里的启停策略送进 `ctx.skills`。
 *
 * 为什么是一个「提供方」而不是直接改文件：注册表按名字裁决，同层内 rank 小者胜。
 * 本提供方只对**有覆盖的技能**发出候选，rank 取 `OVERLAY_RANK`（0），低于文件系统
 * 提供方的全部 rank（100..600），因此它必然赢得这些名字的裁决，而它的 `invocation`
 * 就是用户要的策略。源文件一个字节都不动，取消覆盖即回到文件自己的声明。
 *
 * 只发有覆盖的技能，是刻意的克制：全量代理会让我们成为所有技能的必经之路，
 * 一旦本模块出错，整个技能系统就一起坏掉；只覆盖少数几个名字，坏掉的爆炸半径
 * 就限于用户显式动过的那几个。
 *
 * `get()` 必须返回真实正文 —— 我们的候选赢了裁决，模型加载时就会问我们要内容；
 * 返回 undefined 会让「启用」的技能变得不可加载，那是最荒谬的一种失败。
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { buildCatalog, overridesOf } from './catalog.js'
import { OVERLAY_RANK } from './roots.js'

/** 注册进 `ctx.skills` 的提供方名，也是 UI 里区分「这条策略来自谁」的依据。 */
export const PROVIDER_NAME = 'dsh-skills-manager'

/** 本插件写入候选 `metadata` 的键，供消费方识别出这是策略覆盖而非真实文件级声明。 */
export const METADATA_KEY = 'dshSkillsManager'

/**
 * 构造一个提供方实例。
 *
 * `rootsFor` / `overridesFor` 由调用方（index.js）注入而不是在这里读全局，是为了让
 * 每一条注册都绑定到「当前状态」而不是「挂载时刻的状态」：宿主行与每个 agent 作用域
 * 各有一份注册，它们必须在同一次状态变更后一起失效。
 * @param {{
 *   rootsFor: (cwd?: string) => Array<object>,
 *   overridesFor: () => Record<string, Record<string, { enabled: boolean }>>,
 *   readFile?: (path: string) => string|undefined
 * }} deps - 依赖注入
 * @returns {import('@deepseek-ai/dsh-skill').SkillProvider} 提供方
 */
export function createProvider(deps) {
  const readFile = deps.readFile ?? safeReadFile
  return {
    name: PROVIDER_NAME,
    list: async (options) => {
      const catalog = buildCatalog({ roots: deps.rootsFor(options?.cwd), overrides: deps.overridesFor(), readFile })
      return overridesOf(catalog).map((record) => candidateFor(record))
    },
    get: async (candidate, options) => {
      const docPath = candidate?.locator?.docPath
      if (typeof docPath !== 'string') return undefined
      const text = readFile(docPath)
      if (text === undefined) return undefined
      const catalog = buildCatalog({
        roots: deps.rootsFor(options?.cwd),
        overrides: deps.overridesFor(),
        readFile: (path) => (path === docPath ? text : undefined),
      })
      // 重新验证：加载与发现之间文件可能被改名、删除或改写。注册表会拿返回值与所选
      // 候选比对名字，名字不符即判定陈旧并让我们失效 —— 所以这里必须如实返回当前名字。
      const fresh = catalog.winners.get(candidate.name)
      if (!fresh || fresh.docPath !== docPath || !fresh.loadable) return undefined
      return {
        name: fresh.name,
        description: fresh.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: PROVIDER_NAME,
        resourceBase: candidate.resourceBase,
        path: docPath,
        metadata: candidate.metadata,
        content: bodyOf(text),
      }
    },
  }
}

/**
 * 由一条目录记录生成注册表候选。
 * @param {object} record - `buildCatalog` 产出的胜出记录
 * @returns {object} 注册表候选
 */
export function candidateFor(record) {
  return {
    name: record.name,
    description: record.description,
    invocation: {
      modelInvocable: record.effectiveModelInvocable,
      userInvocable: record.effectiveUserInvocable,
    },
    source: record.source,
    provider: PROVIDER_NAME,
    rank: OVERLAY_RANK,
    locator: { rootKey: record.rootKey, docPath: record.docPath, entryName: record.entryName },
    path: record.docPath,
    // 相对资源以文档所在目录为基：bundle 是 `<root>/<name>/`，平铺是 `<root>/` ——
    // `dirname` 一个表达式同时覆盖两种形态，且与文件系统提供方给出的基一致。
    // 不一致的话，模型按指引拼出的 `references/x.md` 会指到别处。
    resourceBase: { kind: 'directory', path: dirname(record.docPath) },
    metadata: {
      [METADATA_KEY]: {
        policyOverride: record.override,
        rootKey: record.rootKey,
        source: record.source,
      },
    },
  }
}

/**
 * 取技能正文。
 * @param {string} text - 文件内容
 * @returns {string} 去掉 frontmatter 的正文
 */
function bodyOf(text) {
  const source = text.replace(/^\uFEFF/, '')
  const match = /^(---|\+\+\+)[ \t]*\r?\n/.exec(source)
  if (!match) return source.trim()
  const rest = source.slice(match[0].length)
  const lines = rest.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---' || line === '...') return lines.slice(i + 1).join('\n').trim()
  }
  return rest.trim()
}

/**
 * 读取文本文件，失败返回 undefined。
 * @param {string} path - 文件路径
 * @returns {string|undefined} 内容
 */
function safeReadFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

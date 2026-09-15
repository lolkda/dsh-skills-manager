/**
 * 面向 Agent 的 skills 工具。
 *
 * 与 HTTP 路由共用同一套 runtime 和 operations，因此模型做的操作和用户在界面上做的
 * 操作落到同一处状态、同一套校验、同一份日志。工具描述里反复强调「仅当用户明确要求」
 * 是因为这些调用会改磁盘；把它们做成「想用就用」的便利工具，等于给每次会话装上
 * 一支会自己开火的枪。
 *
 * `skills_set_enabled` 是唯一不改文件的写操作 —— 它改的是注册表策略，因此可以随时
 * 撤销，也是本插件默认推荐的启停方式。
 */

import { readFileSync } from 'node:fs'

import { buildSkillDocument, readSkillDocument } from './frontmatter.js'
import { createSkill, importDirectory, importMarkdown, importZip, moveToTrash, writeSkillContent } from './operations.js'

/** 渲染成纯文本时的统一形状：先给人看结论，再给模型看结构化数据。 */
const TEXT_OUTPUT = {
  schema: { type: 'object' },
}

/**
 * 注册全部工具。
 * @param {object} ctx - 上下文
 * @param {object} tools - `ctx.tools`
 * @param {object} runtime - `createRuntime()` 的产物
 * @returns {() => void} 注销函数
 */
export function installTools(ctx, tools, runtime) {
  const disposers = TOOLS.map((definition) =>
    tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          return await definition.run(args ?? {}, runtime)
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      },
      presentCall(args) {
        return {
          card: 'generic',
          title: definition.title,
          kind: definition.kind,
          rawInput: definition.present ? definition.present(args ?? {}) : undefined,
        }
      },
    }),
  )
  return () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
}

/** 工具清单。 */
export const TOOLS = [
  {
    name: 'skills_list',
    title: 'List skills',
    kind: 'read',
    description:
      'List the skills DSH currently resolves from its own skill directories, grouped by their source root, including which root wins a duplicate name and whether each skill is currently enabled. Use this before answering questions about which skills exist or why one is not loading.',
    parameters: { type: 'object', properties: { cwd: { type: 'string', description: 'Workspace directory used to resolve project skill roots; defaults to the session directory.' } }, additionalProperties: false },
    async run(args, runtime) {
      const catalog = runtime.catalogFor(args.cwd)
      return {
        ok: true,
        cwd: args.cwd ?? runtime.defaultCwd,
        roots: catalog.roots.map((root) => ({ key: root.key, source: root.source, rank: root.rank, path: root.path, count: root.skills.length })),
        skills: catalog.skills.map((skill) => ({
          name: skill.name,
          root: skill.source,
          path: skill.docPath,
          kind: skill.kind,
          description: skill.description,
          loadable: skill.loadable,
          winner: skill.winner,
          shadowed: skill.shadowed,
          override: skill.override,
          effectiveModelInvocable: skill.effectiveModelInvocable,
          effectiveUserInvocable: skill.effectiveUserInvocable,
        })),
        diagnostics: catalog.diagnostics,
      }
    },
  },
  {
    name: 'skills_get',
    title: 'Read a skill',
    kind: 'read',
    description:
      "Return one skill's full SKILL.md text plus its parsed frontmatter and any diagnostics. Use this to inspect or fix a skill instead of reading the file directly, because it reports why the registry would reject it.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Exact kebab-case skill name.' }, cwd: { type: 'string' } }, required: ['name'], additionalProperties: false },
    async run(args, runtime) {
      const catalog = runtime.catalogFor(args.cwd)
      const winner = catalog.winners.get(args.name)
      if (!winner) return { ok: false, error: `找不到名为 ${args.name} 的技能` }
      const text = readFileSync(winner.docPath, 'utf8')
      return {
        ok: true,
        name: winner.name,
        root: winner.source,
        path: winner.docPath,
        loadable: winner.loadable,
        effectiveModelInvocable: winner.effectiveModelInvocable,
        effectiveUserInvocable: winner.effectiveUserInvocable,
        shadowed: winner.shadowed,
        documents: catalog.skills.filter((s) => s.name === args.name).map((s) => ({ root: s.source, path: s.docPath, shadowed: s.shadowed })),
        diagnostics: winner.diagnostics,
        content: text,
      }
    },
  },
  {
    name: 'skills_set_enabled',
    title: 'Enable or disable a skill',
    kind: 'edit',
    description:
      'Enable or disable a skill by changing the invocation policy DSH uses for it. The skill file on disk is never modified, so the change is reversible at any time. Pass enabled=false to stop DSH from loading a skill, enabled=true to force it available even when the file itself opts out, or enabled=null to clear the override and fall back to the file.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact kebab-case skill name.' },
        enabled: { type: ['boolean', 'null'], description: 'true to enable, false to disable, null to clear the override.' },
        cwd: { type: 'string' },
      },
      required: ['name', 'enabled'],
      additionalProperties: false,
    },
    present: (args) => `${args.name} → ${args.enabled === null ? 'clear' : args.enabled ? 'enable' : 'disable'}`,
    async run(args, runtime) {
      const catalog = runtime.catalogFor(args.cwd)
      const winner = catalog.winners.get(args.name)
      if (!winner) return { ok: false, error: `找不到名为 ${args.name} 的技能` }
      return runtime.setEnabled({ rootKey: winner.rootKey, name: args.name, enabled: args.enabled, cwd: args.cwd })
    },
  },
  {
    name: 'skills_create',
    title: 'Create a skill',
    kind: 'edit',
    description:
      'Create a new local DSH skill under the user skill root ($DSH_HOME/skills) as a directory bundle. Use only when the user explicitly asks to create or save a reusable skill.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name; it will be normalized to kebab-case.' },
        description: { type: 'string', description: 'A concise routing description for when to use the skill.' },
        whenToUse: { type: 'string' },
        body: { type: 'string', description: 'Markdown instructions that form the skill body.' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
    present: (args) => args.name,
    async run(args, runtime) {
      const root = userRoot(runtime, args.cwd)
      if (!root) return { ok: false, error: '找不到用户级技能根目录（$DSH_HOME/skills）' }
      const result = createSkill({ root, name: args.name, description: args.description, whenToUse: args.whenToUse, body: args.body })
      if (result.ok) runtime.invalidate()
      return result
    },
  },
  {
    name: 'skills_update',
    title: 'Update a skill document',
    kind: 'edit',
    description:
      'Replace the whole SKILL.md text of an existing skill. The save is refused when the result would not be loadable, so a broken edit can never silently disable a skill. Prefer this over writing the file directly, because it validates frontmatter and reports exactly what is wrong.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact kebab-case skill name.' },
        content: { type: 'string', description: 'The full new file text, including its frontmatter block.' },
        cwd: { type: 'string' },
      },
      required: ['name', 'content'],
      additionalProperties: false,
    },
    present: (args) => args.name,
    async run(args, runtime) {
      const catalog = runtime.catalogFor(args.cwd)
      const winner = catalog.winners.get(args.name)
      if (!winner) return { ok: false, error: `找不到名为 ${args.name} 的技能` }
      const root = runtime.rootsFor(args.cwd).find((item) => item.key === winner.rootKey)
      if (!root) return { ok: false, error: '技能所属的根目录当前不可用' }
      if (root.mutable === false) return { ok: false, error: `${root.source} 是只读根目录，不能修改` }
      const result = writeSkillContent({ docPath: winner.docPath, rootPath: root.path, content: args.content })
      if (result.ok) runtime.invalidate()
      return result
    },
  },
  {
    name: 'skills_delete',
    title: 'Delete a skill',
    kind: 'edit',
    description:
      'Move a skill into the skills-manager trash. Nothing is permanently removed and the deletion can be undone from Settings. Use only when the user explicitly asks to delete a skill.',
    parameters: { type: 'object', properties: { name: { type: 'string' }, cwd: { type: 'string' } }, required: ['name'], additionalProperties: false },
    present: (args) => args.name,
    async run(args, runtime) {
      const catalog = runtime.catalogFor(args.cwd)
      const winner = catalog.winners.get(args.name)
      if (!winner) return { ok: false, error: `找不到名为 ${args.name} 的技能` }
      const root = runtime.rootsFor(args.cwd).find((item) => item.key === winner.rootKey)
      if (!root) return { ok: false, error: '技能所属的根目录当前不可用' }
      const result = moveToTrash({ dshHome: runtime.settings.dshHome, root, skill: winner })
      if (result.ok) {
        runtime.setEnabled({ rootKey: winner.rootKey, name: args.name, enabled: null, cwd: args.cwd })
        runtime.invalidate()
      }
      return result
    },
  },
  {
    name: 'skills_import',
    title: 'Import a skill',
    kind: 'edit',
    description:
      'Import a skill from a local path: a ZIP archive, a directory containing SKILL.md, or a single Markdown file. It is normalized into a directory bundle under the user skill root. Use only when the user explicitly asks to import a skill.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a .zip file, a skill directory, or a .md file.' },
        overwrite: { type: 'boolean', description: 'Replace an existing skill with the same name.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    present: (args) => args.path,
    async run(args, runtime) {
      const root = userRoot(runtime, args.cwd)
      if (!root) return { ok: false, error: '找不到用户级技能根目录（$DSH_HOME/skills）' }
      const overwrite = args.overwrite === true
      let result
      if (/\.zip$/i.test(args.path)) {
        result = importZip({ root, buffer: readFileSync(args.path), overwrite })
      } else if (/\.md$/i.test(args.path)) {
        result = importMarkdown({ root, fileName: args.path, data: readFileSync(args.path), overwrite })
      } else {
        result = importDirectory({ root, sourcePath: args.path, overwrite })
      }
      if (result.ok) runtime.invalidate()
      return result
    },
  },
]

/**
 * 取用户级技能根。
 * @param {object} runtime - 运行时
 * @param {string|undefined} cwd - 工作目录
 * @returns {object|undefined} 根定义
 */
function userRoot(runtime, cwd) {
  return runtime.rootsFor(cwd).find((root) => root.source === 'user-dsh')
}

export { buildSkillDocument, readSkillDocument }

/**
 * 会写盘的操作：新建、编辑、导入、删除。
 *
 * 这一层被 HTTP 路由和 Agent 工具**共用** —— 两条入口如果各写一套，迟早会出现
 * 「界面上能删、模型删不掉」这类行为分叉。因此所有写入路径只在这里实现一次。
 *
 * 两条不可协商的规则：
 *  1. 任何写入目标都必须落在调用方给出的根目录**之内**（`within`）。根目录来自
 *     我们自己的根列表查表，但目标路径会经过多段拼接，仍然逐次校验，避免拼错或
 *     符号链接把它带出边界。
 *  2. 编辑保存必须先解析出**可加载**的文档，否则拒绝 —— 让一次保存把技能悄悄弄成
 *     注册表会丢弃的样子，是这类工具最伤人的失败。
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import { buildSkillDocument, isSkillName, normalizeSkillName, readSkillDocument } from './frontmatter.js'
import { readZip, safeEntryPath } from './zip.js'
import { buildCatalog } from './catalog.js'
import { pathIdentity } from './roots.js'

/** 单个导入文件与整包的大小上限，避免一次导入把内存吃光。 */
const MAX_IMPORT_FILE_BYTES = 32 << 20
const MAX_IMPORT_TOTAL_BYTES = 128 << 20
const MAX_IMPORT_ENTRIES = 2000

/**
 * 构造一个失败结果。
 * @param {string} code - 机器可读错误码
 * @param {string} error - 人类可读说明
 * @param {object} [extra] - 附加字段
 * @returns {{ ok: false, code: string, error: string }} 失败结果
 */
function fail(code, error, extra) {
  return { ok: false, code, error, ...extra }
}

/**
 * 判断目标路径是否严格位于某个根目录之内。
 * @param {string} rootPath - 根目录
 * @param {string} target - 目标路径
 * @returns {boolean} 是否在根内
 */
export function within(rootPath, target) {
  if (typeof rootPath !== 'string' || typeof target !== 'string') return false
  const nested = (root, full) => {
    if (process.platform === 'win32') { root = root.toLowerCase(); full = full.toLowerCase() }
    return full !== root && full.startsWith(root.endsWith(sep) ? root : root + sep)
  }
  const root = resolve(rootPath)
  const full = resolve(target)
  if (!nested(root, full)) return false
  try {
    return nested(canonicalDestination(root), canonicalDestination(full))
  } catch {
    // 拒绝损坏的链接、权限不足和非目录父项，不能把解析失败当作普通新文件。
    return false
  }
}

/**
 * 解析实际落盘位置；目标未创建时从最近存在的祖先推导。
 * lstat 先检查链接自身，避免把悬空链接当作不存在的普通文件。
 * @param {string} path - 绝对路径
 * @returns {string} 解析链接后的目标
 */
function canonicalDestination(path) {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync.native(path)
  const parent = dirname(path)
  if (parent === path) throw new Error('路径没有可解析的祖先')
  return join(canonicalDestination(parent), basename(path))
}

/**
 * 同目录暂存后替换目录项，不截断原 inode：硬链接的其它名字不会被改写。
 * 调用方必须先完成根能力和实际路径校验。
 * @param {string} path - 已验证的文档路径
 * @param {string} content - 完整文档
 * @returns {object} 可选的清理警告
 */
function writeDocumentAtomic(path, content) {
  const mode = statSync(path, { throwIfNoEntry: false })?.mode
  const staging = mkdtempSync(join(dirname(path), '.dshsm-write-'))
  let warning
  try {
    const temp = join(staging, 'document.tmp')
    writeFileSync(temp, content, { encoding: 'utf8', ...(mode === undefined ? {} : { mode: mode & 0o777 }) })
    renameSync(temp, path)
  } finally {
    try { rmSync(staging, { recursive: true, force: true }) } catch (error) {
      warning = `文档暂存目录清理失败：${staging}：${String(error)}`
    }
  }
  return warning ? { warning } : {}
}

/**
 * 在指定根目录下新建一个技能（目录 bundle 形态）。
 * @param {{ root: object, name: string, description: string, whenToUse?: string, body?: string, overwrite?: boolean }} input - 新建参数
 * @returns {object} 结果
 */
export function createSkill(input) {
  const root = input.root
  if (!root || typeof root.path !== 'string') return fail('root.unknown', '未知的技能根目录')
  if (root.mutable === false) return fail('root.readOnly', `${root.source} 是只读根目录，不能新建技能`)
  const name = normalizeSkillName(input.name)
  if (!isSkillName(name)) return fail('name.invalid', '技能名规范化后为空，请使用字母、数字与连字符')
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (!description) return fail('description.missing', 'description 是必填项')

  const dir = join(root.path, name)
  const docPath = join(dir, 'SKILL.md')
  if (!within(root.path, docPath)) return fail('path.escape', '目标路径越出了根目录')
  const namesakes = buildCatalog({ roots: [root] }).skills.filter(skill => skill.name === name)
  // create 不得因目录名不同而悄悄增加第二条同名技能；跨形态替换交给原子导入。
  if (namesakes.length > 0 && (!input.overwrite || namesakes.some(skill => pathIdentity(skill.docPath) !== pathIdentity(docPath)))) {
    return fail('skill.exists', `技能 ${name} 已存在：${namesakes.map(skill => skill.docPath).join('、')}`)
  }
  if (existsSync(dir) && !input.overwrite) return fail('skill.exists', `技能 ${name} 已存在：${docPath}`)


  const content = buildSkillDocument({ name, description, whenToUse: input.whenToUse, body: input.body })
  const parsed = readSkillDocument(content)
  if (!parsed.loadable) return fail('document.invalid', '生成的文档未通过校验', { diagnostics: parsed.diagnostics })

  mkdirSync(dir, { recursive: true })
  const written = writeDocumentAtomic(docPath, content)
  return { ok: true, name, path: docPath, rootKey: root.key, ...written }
}

/**
 * 整份替换一个技能文档。
 *
 * 刻意不做「只改某几行」的增量写：整份替换的语义是用户可以理解和验证的，
 * 而按行修补会在遇到块标量、注释、CRLF 时产出用户没写过的内容。
 * @param {{ docPath: string, root: object, content: string }} input - 编辑参数；完整根对象携带只读能力
 * @returns {object} 结果
 */
export function writeSkillContent(input) {
  if (!input.root || typeof input.root.path !== 'string') return fail('root.unknown', '保存需要完整的技能根定义')
  if (input.root.mutable === false) return fail('root.readOnly', '只读根目录不能修改技能')
  if (!within(input.root.path, input.docPath)) return fail('path.escape', '目标路径越出了根目录')
  if (!existsSync(input.docPath)) return fail('skill.missing', '技能文件已不存在')
  const content = typeof input.content === 'string' ? input.content : ''
  if (content.length > MAX_IMPORT_FILE_BYTES) return fail('content.tooLarge', '内容过大')
  const parsed = readSkillDocument(content)
  if (!parsed.loadable) {
    return fail('document.invalid', '保存后会变成注册表无法加载的技能，请先修正下列问题', { diagnostics: parsed.diagnostics })
  }
  const written = writeDocumentAtomic(input.docPath, content)
  return { ok: true, name: parsed.name, path: input.docPath, ...written }
}

/**
 * 删除一条技能（**永久删除**，不进回收站）。
 *
 * 界面上的「回收站」已经按用户要求整个拿掉：删除就是删除。所以这里唯一要保证的是
 * 「删干净」—— bundle 删整个目录，平铺文件删那个文件，两者都是「用户看到的那个技能」的
 * 完整载体，只删一半会留下看起来删掉了、其实还在生效的残余。
 *
 * 只读根（bundled）不允许删；目标路径必须落在根目录之内。
 * @param {{ root: object, skill: object }} input - 删除参数
 * @returns {object} 结果
 */
export function deleteSkill(input) {
  const { root, skill } = input
  if (!root || root.mutable === false) return fail('root.readOnly', '只读根目录不能删除')
  const entryPath = skill.kind === 'bundle' ? dirname(skill.docPath) : skill.docPath
  if (!within(root.path, entryPath)) return fail('path.escape', '目标路径越出了根目录')
  if (!existsSync(entryPath)) return fail('skill.missing', '技能已不存在')
  try {
    rmSync(entryPath, { recursive: true, force: true })
  } catch (error) {
    return fail('skill.deleteFailed', `删除失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ok: true, name: skill.name, path: entryPath }
}

/**
 * 导入一组文件作为一个技能。
 *
 * 目标是「无论用户丢进来的是单个 SKILL.md、一个技能目录，还是打包好的 ZIP，结果
 * 都落在同一个规范形态上」：`<root>/<name>/SKILL.md` 加原样保留的附属文件。
 * @param {{ root: object, files: Array<{ name: string, data: Buffer }>, overwrite?: boolean }} input - 导入参数
 * @returns {object} 结果
 */
export function importFiles(input) {
  const root = input.root
  if (!root || typeof root.path !== 'string') return fail('root.unknown', '未知的技能根目录')
  if (root.mutable === false) return fail('root.readOnly', `${root.source} 是只读根目录，不能导入`)
  const files = (input.files ?? []).filter((file) => file && !file.isDirectory && file.data)
  if (files.length === 0) return fail('import.empty', '没有可导入的文件')
  if (files.length > MAX_IMPORT_ENTRIES) return fail('import.tooMany', `文件数超过 ${MAX_IMPORT_ENTRIES} 上限`)
  let total = 0
  for (const file of files) {
    total += file.data.length
    if (file.data.length > MAX_IMPORT_FILE_BYTES) return fail('import.tooLarge', `文件 ${file.name} 过大`)
  }
  if (total > MAX_IMPORT_TOTAL_BYTES) return fail('import.tooLarge', '导入内容总大小超限')

  const located = locateDocument(files)
  if (!located.ok) return located
  const { doc, bundleRoot } = located
  const parsed = readSkillDocument(doc.data.toString('utf8'))
  if (!parsed.loadable) {
    return fail('document.invalid', '技能文档未通过校验', { diagnostics: parsed.diagnostics })
  }
  const name = parsed.name
  const dir = join(root.path, name)
  if (!within(root.path, dir)) return fail('path.escape', '目标路径越出了根目录')
  const namesakes = buildCatalog({ roots: [root] }).skills.filter(skill => skill.name === name)
  if (namesakes.length > 1) return fail('skill.ambiguous', `技能 ${name} 已存在于多个文档，请先选择并删除多余项`)
  const original = namesakes[0]
  const originalPath = original ? (original.kind === 'bundle' ? dirname(original.docPath) : original.docPath) : undefined
  if (original && !input.overwrite) return fail('skill.exists', `技能 ${name} 已存在，请先删除或选择覆盖`)
  if (originalPath && !within(root.path, originalPath)) return fail('path.escape', '原技能实际路径越出了根目录')
  // 规范化目录若被另一技能或未识别的目录占用，不能以 overwrite 名义顺带删除它。
  if (existsSync(dir) && (!originalPath || pathIdentity(originalPath) !== pathIdentity(dir))) {
    return fail('skill.exists', `规范化目标目录已被其它内容占用：${dir}`)
  }

  // 先规划全部条目，绝不在校验中途删除已有包。
  const plan = []
  const destinations = new Set()
  for (const file of files) {
    if (bundleRoot && !file.name.startsWith(bundleRoot)) continue
    const rel = file === doc ? 'SKILL.md' : file.name.slice(bundleRoot.length)
    const normalized = safeEntryPath(rel)
    // NTFS 的 : 数据流与默认流别名不是独立附件，不能绕过主文档的校验。
    if (!normalized || rel.includes(':') || /^[\\/]/.test(rel) || !within(dir, join(dir, normalized))) {
      return fail('path.escape', `条目 ${file.name} 不是安全的技能内相对路径`)
    }
    const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized
    if (destinations.has(identity)) return fail('import.duplicatePath', `多个条目写入同一文件：${normalized}`)
    destinations.add(identity)
    plan.push({ relative: normalized, data: file.data })
  }

  let workspace
  let movedOriginal = false
  let committed = false
  let retainRecovery = false
  let result
  try {
    mkdirSync(root.path, { recursive: true })
    workspace = mkdtempSync(join(root.path, '.dshsm-import-'))
    const staged = join(workspace, 'bundle')
    const backup = join(workspace, 'backup')
    mkdirSync(staged)
    for (const file of plan) {
      const target = join(staged, file.relative)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, file.data)
    }
    // 同卷提交：暂存完整包之后才移动原包，提交失败则恢复原目录。
    if (existsSync(dir) && (!originalPath || pathIdentity(originalPath) !== pathIdentity(dir))) {
      throw new Error('规范化目标在导入期间被其它内容占用')
    }
    if (originalPath) {
      if (!existsSync(originalPath) || !within(root.path, originalPath)) throw new Error('原技能实际路径在导入期间发生变化')
      // 原技能可能是 flat 文件或采用其它目录名的 bundle，均只替换这个唯一实体。
      renameSync(originalPath, backup)
      movedOriginal = true
    }
    renameSync(staged, dir)
    committed = true
    result = { ok: true, name, path: join(dir, 'SKILL.md'), rootKey: root.key, files: plan.length }
  } catch (error) {
    result = fail('import.writeFailed', `导入未完成：${error instanceof Error ? error.message : String(error)}`)
    if (movedOriginal && !committed) {
      const backup = join(workspace, 'backup')
      try {
        renameSync(backup, originalPath)
      } catch (rollbackError) {
        // 回滚也失败时保住原包，绝不能在清理阶段把仅剩的备份删掉。
        retainRecovery = true
        result.recoveryPath = backup
        result.error += `；原包保留在 ${backup}，自动恢复失败：${String(rollbackError)}`
      }
    }
  }
  if (workspace && !retainRecovery) {
    try { rmSync(workspace, { recursive: true, force: true }) } catch (error) {
      result.cleanupPath = workspace
      result.warning = `暂存清理失败，未删除恢复材料：${String(error)}`
    }
  }
  return result
}

/**
 * 从 ZIP 字节导入。
 * @param {{ root: object, buffer: Buffer, overwrite?: boolean }} input - 导入参数
 * @returns {object} 结果
 */
export function importZip(input) {
  const archive = readZip(input.buffer)
  if (!archive.ok) return fail('import.badZip', archive.error)
  return importFiles({ root: input.root, files: archive.entries, overwrite: input.overwrite })
}

/**
 * 从一个本地目录导入。
 * @param {{ root: object, sourcePath: string, overwrite?: boolean }} input - 导入参数
 * @returns {object} 结果
 */
export function importDirectory(input) {
  let files
  try {
    files = readTree(input.sourcePath)
  } catch (error) {
    return fail('import.unreadable', `无法读取目录：${error instanceof Error ? error.message : String(error)}`)
  }
  if (files.length === 0) return fail('import.empty', '目录里没有文件')
  return importFiles({ root: input.root, files, overwrite: input.overwrite })
}

/**
 * 从一个独立的 Markdown 文件导入。
 * @param {{ root: object, fileName: string, data: Buffer, overwrite?: boolean }} input - 导入参数
 * @returns {object} 结果
 */
export function importMarkdown(input) {
  return importFiles({
    root: input.root,
    files: [{ name: basename(input.fileName || 'SKILL.md'), data: input.data, isDirectory: false }],
    overwrite: input.overwrite,
  })
}

/**
 * 在读入的文件集合里定位技能文档。
 *
 * 优先级：最浅的 `SKILL.md` → 最浅的其它 `.md`。只看浅层是刻意的：一个压缩包里
 * 常带 `docs/`、`.github/` 之类的 Markdown，按名字随便挑一个会让导入把 README
 * 当成技能。
 * @param {Array<{ name: string, data: Buffer }>} files - 文件集合
 * @returns {{ ok: true, doc: object, bundleRoot: string } | object} 定位结果
 */
function locateDocument(files) {
  const depth = (name) => name.split('/').length
  const skillDocs = files.filter((file) => basename(file.name).toLowerCase() === 'skill.md')
  const pool = skillDocs.length > 0 ? skillDocs : files.filter((file) => /\.md$/i.test(file.name))
  if (pool.length === 0) return fail('import.noDocument', '压缩包里没有找到 SKILL.md 或任何 Markdown 文件')
  const doc = [...pool].sort((a, b) => depth(a.name) - depth(b.name) || a.name.localeCompare(b.name))[0]
  const parts = doc.name.split('/')
  const bundleRoot = parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : ''
  return { ok: true, doc, bundleRoot }
}

/**
 * 递归读入一个目录下的全部文件。
 * @param {string} root - 源目录
 * @returns {Array<{ name: string, data: Buffer, isDirectory: boolean }>} 文件列表
 */
function readTree(root) {
  const out = []
  /**
   * 递归下行。
   * @param {string} current - 当前目录
   * @returns {void}
   */
  const walk = (current) => {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, dirent.name)
      const rel = relative(root, full).split(sep).join('/')
      if (dirent.isDirectory()) {
        if (dirent.name === '.git' || dirent.name === 'node_modules') continue
        out.push({ name: rel, data: Buffer.alloc(0), isDirectory: true })
        walk(full)
        continue
      }
      if (!dirent.isFile()) continue
      out.push({ name: rel, data: readFileSync(full), isDirectory: false })
    }
  }
  walk(root)
  return out
}

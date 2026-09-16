/**
 * 修复无法被 DSH 加载的 frontmatter：把会解析失败的标量值加上引号。
 *
 * 这是维护工具，不是插件功能 —— 但它走的是**插件自己的读写路径**：目录来自
 * `lib/catalog.js`，值来自 `lib/frontmatter.js` 的解析与引号化，写入与最终校验来自
 * `lib/operations.js` 的 `writeSkillContent`（它会先 `readSkillDocument` 校验，不合格就
 * 拒绝写入）。所以它做的正是编辑器里手工改一遍会发生的事，而不是绕开插件去 sed 文件。
 *
 * 实现上刻意**逐行原位替换**而不是"解析后再拼回去"：`splitDocument` 会把整份文档的换行
 * 统一成 LF，用它重建会把 CRLF 文件里的每一个 \r 都吃掉 —— 那就不是"只改一行"了。
 * 改完 `diff` 应当只有一行差异，这一点请自己核对。
 *
 * 用法：node spike/repair-frontmatter.mjs <技能名> [--cwd <目录>] [--dry-run]
 */

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { buildCatalog } from '../lib/catalog.js'
import { quoteScalar, readSkillDocument } from '../lib/frontmatter.js'
import { writeSkillContent } from '../lib/operations.js'
import { listRoots } from '../lib/roots.js'
import { storeDir } from '../lib/store.js'

const args = process.argv.slice(2)
const name = args[0]
const value = (flag, fallback) => {
  const index = args.indexOf(`--${flag}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const dryRun = args.includes('--dry-run')
const cwd = value('cwd', process.cwd())
const dshHome = value('home', join(homedir(), '.dsh'))

if (!name) {
  console.error('用法：node spike/repair-frontmatter.mjs <技能名> [--cwd <目录>] [--dry-run]')
  process.exit(2)
}

const roots = listRoots({ cwd, env: process.env, config: { dshHome } })
const catalog = buildCatalog({ roots, overrides: {} })
const record = catalog.skills.find((item) => item.name === name)
if (!record) {
  console.error(`目录里没有名为 ${name} 的技能`)
  process.exit(1)
}

const original = readFileSync(record.docPath, 'utf8')
const doc = readSkillDocument(original)
if (doc.loadable) {
  console.log(`${name} 已经可以被 DSH 加载，无需修复`)
  process.exit(0)
}

const eol = original.includes('\r\n') ? '\r\n' : '\n'
const lines = original.split(/\r?\n/)

/** frontmatter 的结束行号（独占一行的 `---`）。 */
let end = -1
for (let i = 1; i < lines.length; i++) {
  if (lines[i].trim() === '---') {
    end = i
    break
  }
}
if (lines[0].trim() !== '---' || end < 0) {
  console.error(`${name} 的 frontmatter 结构异常，本工具不处理`)
  process.exit(1)
}

/**
 * 这个值会不会被 DSH 的 `yaml` 库判为解析失败。
 *
 * 与 `lib/frontmatter.js` 的判据一致：未加引号的值里出现 `: ` 是嵌套映射，以 YAML
 * 指示符开头则会产出非字符串结构 —— 两种都会让整条技能被丢弃。
 * @param {string} inline - `key: ` 后面的原始文本
 * @returns {boolean} 是否会解析失败
 */
const willFail = (inline) => /:(\s|$)/.test(inline) || /^[[\]{}&*!%@`]/.test(inline)

const originalLines = lines.slice()
const touched = []
for (let i = 1; i < end; i++) {
  const match = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(lines[i])
  if (!match) continue
  const inline = match[2].replace(/\r$/, '')
  if (inline === '' || /^["'|>]/.test(inline) || !willFail(inline)) continue
  // 用解析后的值而不是原始文本：原始文本可能带着引号或转义，直接包一层会坏掉。
  const parsed = new Map([
    ['name', doc.name],
    ['description', doc.description],
    ['whenToUse', doc.whenToUse],
  ]).get(match[1])
  if (typeof parsed !== 'string') continue
  touched.push(match[1])
  lines[i] = `${match[1]}: ${quoteScalar(parsed)}`
  console.log(`  加引号：${match[1]}（${inline.length} → ${lines[i].length - match[1].length - 2} 字符）`)
}

if (touched.length === 0) {
  console.error('没有找到可修复的行，放弃')
  process.exit(1)
}

const next = lines.join(eol)
const after = readSkillDocument(next)
if (!after.loadable) {
  console.error('修复后仍然无法加载，放弃：')
  for (const item of after.diagnostics) console.error(`  ${item.code}: ${item.message}`)
  process.exit(1)
}

// 逐行核对：除目标行外必须逐字节一致，否则宁可不动。
const nextLines = next.split(/\r?\n/)
const changed = originalLines.map((line, index) => (nextLines[index] === line ? null : index + 1)).filter((index) => index !== null)
console.log(`  变动的行：${changed.join(', ')}（共 ${changed.length} 行）`)
if (changed.length !== touched.length) {
  console.error('改动行数与预期不符，放弃')
  process.exit(1)
}

if (dryRun) {
  console.log(`${name} 生成修复内容（${Buffer.byteLength(original)} → ${Buffer.byteLength(next)} 字节），未写入`)
  process.exit(0)
}

// 备份放在插件自己的状态目录里 —— 放到技能目录旁边有被当成技能文件扫到的风险。
const backupDir = join(storeDir(dshHome), 'backups')
mkdirSync(backupDir, { recursive: true })
const backupPath = join(backupDir, `${name}-${Date.now()}.md`)
copyFileSync(record.docPath, backupPath)

const rootPath = roots.find((root) => root.key === record.rootKey).path
const result = writeSkillContent({ docPath: record.docPath, rootPath, content: next })
console.log(`${name}: ${JSON.stringify(result)}`)
console.log(`  备份 → ${backupPath}`)
if (!result.ok) process.exit(1)

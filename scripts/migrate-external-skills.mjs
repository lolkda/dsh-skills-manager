/**
 * 把外部目录里的技能迁移进 DSH 自己的技能根。
 *
 * 背景：`@michengai/dsh-skills-manager` 聚合了 `~/.cc-switch/skills`、`~/.codex/skills`、
 * `~/.claude/skills` 这些**外部**目录，其中一部分技能在 DSH 自有目录里并不存在。移除那个
 * 插件之后，这些技能会一并从技能目录里消失 —— 它们本来就是靠那个插件才可见的。
 *
 * 这个脚本把它们**导入**（不是链接、不是复制目录）到 `$DSH_HOME/skills`，导入后它们就是
 * 普通的 DSH 自有技能，由本插件统一管理，不再依赖任何外部目录。
 *
 * 刻意复用 `lib/operations.js` 的 `importDirectory` 而不是自己写拷贝：导入在这里有一套
 * 既定语义（文档统一落成 `SKILL.md`、目录名取自 frontmatter 的 `name`、逐条边界校验），
 * 各写一套迟早会分叉。
 *
 * 默认**不覆盖**已存在的技能，因此可以反复运行。
 *
 * 用法：
 *   node scripts/migrate-external-skills.mjs [--source <目录>] [--overwrite] [--dry-run]
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { importDirectory } from '../lib/operations.js'
import { listRoots } from '../lib/roots.js'

/**
 * 需要迁移的源目录名。
 *
 * 注意目录名不一定是技能名：`apple-design-skill-project` 里的 frontmatter 声明的是
 * `name: apple-liquid-glass`。这里按目录名列出，实际落盘名字由 frontmatter 决定。
 */
const SOURCES = ['apple-design-skill-project', 'frontend-ui-system', 'improve-codebase-architecture', 'reverse-flow']

/**
 * 读一个 `--flag value` 形式的参数。
 * @param {string[]} argv - 命令行参数
 * @param {string} flag - 参数名
 * @returns {string|undefined} 参数值
 */
function option(argv, flag) {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const overwrite = argv.includes('--overwrite')
const sourceBase = option(argv, '--source') ?? join(homedir(), '.cc-switch', 'skills')

const roots = listRoots({ cwd: process.cwd(), env: process.env, config: {} })
const target = roots.find((root) => root.source === 'user-dsh')
if (!target) {
  console.error(`找不到用户级技能根（$DSH_HOME/skills）。已发现的根：${roots.map((root) => root.source).join(', ')}`)
  process.exit(1)
}

console.log(`源目录  : ${sourceBase}`)
console.log(`目标根  : ${target.path}  （${target.key}）`)
console.log(`模式    : ${dryRun ? '预演，不写盘' : overwrite ? '允许覆盖同名技能' : '已存在则跳过'}`)
console.log('')

let imported = 0
let skipped = 0
let failed = 0

for (const name of SOURCES) {
  const sourcePath = join(sourceBase, name)
  if (!existsSync(sourcePath)) {
    console.log(`  跳过  ${name} —— 源目录不存在`)
    skipped += 1
    continue
  }
  if (dryRun) {
    console.log(`  预演  ${name} —— 会导入到 ${target.path}`)
    continue
  }
  const result = importDirectory({ root: target, sourcePath, overwrite })
  if (result.ok) {
    console.log(`  导入  ${name}  ->  ${result.name}（${result.files} 个文件）`)
    imported += 1
  } else if (result.code === 'skill.exists') {
    console.log(`  跳过  ${name} —— ${result.error}`)
    skipped += 1
  } else {
    console.log(`  失败  ${name} —— ${result.error}`)
    const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : []
    for (const item of diagnostics) console.log(`        ${item.message}`)
    failed += 1
  }
}

console.log('')
console.log(`导入 ${imported} 条，跳过 ${skipped} 条，失败 ${failed} 条。`)
if (dryRun) console.log('（预演模式，磁盘未改动）')
process.exit(failed > 0 ? 1 : 0)

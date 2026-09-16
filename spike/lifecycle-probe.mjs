/**
 * 完整生命周期的真机验收：新建 → 导入 → 删除 → 恢复，每一步都用**新建会话**核对。
 *
 * 为什么每一步都要起一个会话：宿主层视图在真实部署里是空的（技能由 preset 层提供），
 * 所以"目录里有没有这条技能"这个问题的唯一可信答案来自一个真实 agent 解析出的技能目录。
 * 只查插件自己的接口，等于让被告自己作证。
 *
 * 前提：另有一个 web 实例在监听（不碰用户正在用的那个）：
 *   dsh web --port 3099 --no-open
 *
 * 用法：node spike/lifecycle-probe.mjs [--base http://127.0.0.1:3099] [--cwd <目录>] [--keep]
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { makeZip } from './make-zip.mjs'

const run = promisify(execFile)
const here = fileURLToPath(new URL('.', import.meta.url))

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(`--${flag}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = value('base', 'http://127.0.0.1:3099')
const cwd = value('cwd', process.cwd())
const keep = args.includes('--keep')
const dshHome = join(homedir(), '.dsh')
const logPath = join(dshHome, 'dsh-skills-manager', 'dsh-skills-manager.log')

// 用户技能根（$DSH_HOME/skills）。新建与导入都落在这里。
const USER_ROOT = 'dsh'
const CREATED = 'probe-lifecycle'
const IMPORTED = 'probe-zipped'
const failures = []

/**
 * 调一个插件端点。
 * @param {string} path - 端点
 * @param {object} [body] - POST 请求体
 * @returns {Promise<object>} 响应
 */
async function call(path, body) {
  const response = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}cwd=${encodeURIComponent(cwd)}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.json()
}

/**
 * 起一个真实会话，读出**那个会话**解析到的技能名。
 * @returns {Promise<string[]>} 技能名
 */
async function sessionSkills() {
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').length : 0
  await run(process.execPath, [join(here, 'session-probe.mjs'), '--cwd', cwd], { timeout: 120000 })
  const lines = readFileSync(logPath, 'utf8').split('\n').slice(before)
  const hit = lines.filter((line) => line.includes('scope-snapshot')).pop()
  if (!hit) throw new Error('没有从活动日志里拿到 scope-snapshot —— 会话可能没建立起来')
  const detail = JSON.parse(hit).detail
  const tail = detail.split('——')[1] ?? ''
  return tail
    .split('、')
    .map((item) => item.replace(/（模型不可用）/, '').trim())
    .filter(Boolean)
}

/**
 * 断言，并记录失败而不是立刻中断 —— 收尾清理必须跑到。
 * @param {boolean} ok - 是否通过
 * @param {string} label - 描述
 * @param {unknown} [detail] - 附加信息
 */
function check(ok, label, detail) {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

console.log(`目标实例：${base}`)
console.log(`工作目录：${cwd}\n`)

let trashIds = []
try {
  console.log('1) 新建技能')
  const created = await call('/dsh-skills-manager/skill/create', {
    rootKey: USER_ROOT,
    name: CREATED,
    description: '生命周期验收用的临时技能，用完即删',
    body: '# 临时技能\n\n由 spike/lifecycle-probe.mjs 创建。\n',
  })
  check(created.ok === true, 'POST /skill/create 成功', JSON.stringify(created.error ?? created.name))
  check(existsSync(join(dshHome, 'skills', CREATED, 'SKILL.md')), '磁盘上出现 SKILL.md')

  let names = await sessionSkills()
  check(names.includes(CREATED), '新会话里能看到它', `${names.length} 条`)

  console.log('\n2) 用 ZIP 导入')
  const zip = makeZip([
    { name: `${IMPORTED}/SKILL.md`, data: `---\nname: ${IMPORTED}\ndescription: 由 ZIP 导入的临时技能\n---\n\n正文\n`, deflate: true },
    { name: `${IMPORTED}/references/note.md`, data: '附件内容', deflate: true },
  ])
  const imported = await call('/dsh-skills-manager/skill/import', { rootKey: USER_ROOT, kind: 'zip', base64: zip.toString('base64') })
  check(imported.ok === true, 'POST /skill/import（zip）成功', JSON.stringify(imported.error ?? imported.name))
  check(existsSync(join(dshHome, 'skills', IMPORTED, 'references', 'note.md')), 'ZIP 里的附件也还原了')

  names = await sessionSkills()
  check(names.includes(IMPORTED), '新会话里能看到导入的技能')
  check(names.includes(CREATED), '先建的那条也还在')

  console.log('\n3) 删除进回收站')
  const trashed = await call('/dsh-skills-manager/skill/trash', { rootKey: USER_ROOT, name: CREATED })
  check(trashed.ok === true, 'POST /skill/trash 成功', JSON.stringify(trashed.error ?? ''))
  check(existsSync(join(dshHome, 'skills', CREATED, 'SKILL.md')) === false, '源文件已从技能目录移走')

  const catalog = await call('/dsh-skills-manager/catalog')
  const entry = (catalog.data.trash ?? []).find((item) => item.name === CREATED)
  check(entry !== undefined, '回收站里能查到它')
  if (entry) trashIds.push(entry.id)

  names = await sessionSkills()
  check(names.includes(CREATED) === false, '新会话里已经看不到它')
  check(names.includes(IMPORTED), '没被删的那条不受影响')

  console.log('\n4) 从回收站恢复')
  const restored = await call('/dsh-skills-manager/trash/restore', { id: trashIds[0] })
  check(restored.ok === true, 'POST /trash/restore 成功', JSON.stringify(restored.error ?? ''))
  check(existsSync(join(dshHome, 'skills', CREATED, 'SKILL.md')), '文件回到技能目录')

  names = await sessionSkills()
  check(names.includes(CREATED), '新会话里又看得到它')
} finally {
  if (!keep) {
    console.log('\n5) 清理')
    const catalog = await call('/dsh-skills-manager/catalog').catch(() => undefined)
    const pending = [...trashIds, ...((catalog?.data?.trash ?? []).map((item) => item.id))]
    for (const item of [...new Set(pending)]) {
      const purged = await call('/dsh-skills-manager/trash/purge', { id: item }).catch(() => undefined)
      console.log(`  清除回收站条目 ${item}：${purged?.ok === true ? 'ok' : JSON.stringify(purged?.error ?? purged)}`)
    }
    for (const name of [CREATED, IMPORTED]) {
      if (existsSync(join(dshHome, 'skills', name))) {
        const late = await call('/dsh-skills-manager/skill/trash', { rootKey: USER_ROOT, name }).catch(() => undefined)
        console.log(`  兜底删除 ${name}：${late?.ok === true ? '已移入回收站' : JSON.stringify(late?.error ?? '')}`)
      }
    }
    // 兜底删除只把技能移进回收站，还要再扫一遍把回收站清空 —— 否则"清理干净了"这句话
    // 只是把东西挪到了看不见的地方（而且下次同名技能建出来会看起来像有历史覆盖）。
    const after = await call('/dsh-skills-manager/catalog').catch(() => undefined)
    for (const entry of after?.data?.trash ?? []) {
      if (entry.name !== CREATED && entry.name !== IMPORTED) continue
      const purged = await call('/dsh-skills-manager/trash/purge', { id: entry.id }).catch(() => undefined)
      console.log(`  清空回收站 ${entry.name}：${purged?.ok === true ? 'ok' : JSON.stringify(purged?.error ?? '')}`)
    }
    const left = [CREATED, IMPORTED].filter((name) => existsSync(join(dshHome, 'skills', name)))
    check(left.length === 0, '临时技能已离开技能目录', left.join(', '))
    // 必须重新取一次目录：`after` 是清空**之前**的快照，拿它断言只会证明我读了旧数据。
    const settled = await call('/dsh-skills-manager/catalog').catch(() => undefined)
    const rest = (settled?.data?.trash ?? []).filter((entry) => entry.name === CREATED || entry.name === IMPORTED)
    check(rest.length === 0, '回收站里也没有残留', rest.map((entry) => entry.name).join(', '))
  }
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

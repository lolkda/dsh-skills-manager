/**
 * 完整生命周期的真机验收：新建 → 导入 → 删除（永久删除，没有回收站），每一步都用**新建会话**核对。
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
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
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
 * 起一个真实会话，连**模型收到的系统提示**一起取回来。
 *
 * 光看技能名不够：编辑正文要验证的是"改完之后模型看到的描述也变了"，那就得看系统提示。
 * @param {string} dir - 会话工作目录
 * @returns {Promise<string>} 帧内容的文本
 */
async function sessionPrompt(dir) {
  const dump = join(tmpdir(), `dshsm-frames-${Date.now()}.jsonl`)
  await run(process.execPath, [join(here, 'session-probe.mjs'), '--cwd', dir, '--dump', dump], { timeout: 120000 })
  const text = existsSync(dump) ? readFileSync(dump, 'utf8') : ''
  rmSync(dump, { force: true })
  return text
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

    console.log('\n2.5) 编辑正文')
  const content = await call(`/dsh-skills-manager/skill/content?rootKey=${encodeURIComponent(USER_ROOT)}&name=${CREATED}`)
  check(content.ok === true, 'GET /skill/content 读到正文', JSON.stringify(content.error ?? ''))
  // 注意这个端点是扁平的（content 在顶层），与 /catalog 的 { ok, data } 不同 —— 客户端也是这么读的。
  check(typeof content.content === 'string' && content.content.includes(CREATED), '读回的是这个技能的文档')

  const marker = `编辑验收标记-${Date.now()}`
  const edited = content.content.replace(/^description:.*$/m, `description: ${marker}`)
  check(edited !== content.content, '构造出了改动过的正文')
  const saved = await call('/dsh-skills-manager/skill/save', { rootKey: USER_ROOT, name: CREATED, content: edited })
  check(saved.ok === true, 'POST /skill/save 保存成功', JSON.stringify(saved.error ?? ''))

  const prompt = await sessionPrompt(cwd)
  check(prompt.includes(marker), '改动后的描述出现在**模型收到的系统提示**里')

  // 写坏了必须被拦住：这个插件的写入路径能改磁盘上的技能文件，最坏的失败是写进去一份
  // DSH 读不动的文档 —— 那条技能会静默从所有会话里消失。
  const file = join(dshHome, 'skills', CREATED, 'SKILL.md')
  const before = readFileSync(file, 'utf8')
  const broken = await call('/dsh-skills-manager/skill/save', {
    rootKey: USER_ROOT,
    name: CREATED,
    content: `---\nname: ${CREATED}\ndescription: 参考 macOS): 浅灰白底   <- 冒号后跟空格 = YAML 嵌套映射\n---\n\n正文\n`,
  })
  check(broken.ok === false, '非法 frontmatter 被拒绝', JSON.stringify(broken.code ?? ''))
  check(readFileSync(file, 'utf8') === before, '被拒绝的保存没有碰磁盘上的文件')

console.log('')
console.log('3) 删除技能（永久删除）')
  const deleted = await call('/dsh-skills-manager/skill/delete', { rootKey: USER_ROOT, name: CREATED })
  check(deleted.ok === true, 'POST /skill/delete 成功', JSON.stringify(deleted.error ?? ''))
  check(existsSync(join(dshHome, 'skills', CREATED)) === false, '整个目录都已从技能目录删掉')

  names = await sessionSkills()
  check(names.includes(CREATED) === false, '新会话里已经看不到它')
  check(names.includes(IMPORTED), '没被删的那条不受影响')

} finally {
  if (!keep) {
    console.log('')
    console.log('4) 清理')
    for (const name of [CREATED, IMPORTED]) {
      if (existsSync(join(dshHome, 'skills', name))) {
        const late = await call('/dsh-skills-manager/skill/delete', { rootKey: USER_ROOT, name }).catch(() => undefined)
        console.log(`  删除 ${name}：${late?.ok === true ? 'ok' : JSON.stringify(late?.error ?? '')}`)
      }
    }

    const left = [CREATED, IMPORTED].filter((name) => existsSync(join(dshHome, 'skills', name)))
    check(left.length === 0, '临时技能已离开技能目录', left.join(', '))
  }
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

/**
 * 项目级技能根的真机验证。
 *
 * 目标里明确要求管理项目级根（`<项目>/.dsh/skills`、`<项目>/.agents/skills`），但前几轮的
 * 真机验证里一个项目技能都没出现过 —— 全部技能都来自 `$DSH_HOME`。而项目根的解析要经过
 * 「从 cwd 往上找 `.git`」这一步，本插件与 `dsh-skill-filesystem` 各实现了一遍：
 * 两者算法一致不等于真机上一致，一旦不一致，界面就会显示一批模型根本看不到的项目技能。
 *
 * 所以这里造一个真的带 `.git` 的项目目录，放几条项目技能，再起真实会话核对。
 *
 * 关键设计：`probe-shadow` 在项目里与 `$DSH_HOME` 里各放一份，**项目那份带
 * `disable-model-invocation: true`**。会话视图里它显示成「模型不可用」就说明赢的是项目那份
 * （rank 100 胜过 400），反之说明赢的是用户那份。会话视图只列名字，这个差异就是判别依据。
 *
 * 用法：node spike/project-root-probe.mjs
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = fileURLToPath(new URL('.', import.meta.url))
const dshHome = join(homedir(), '.dsh')
const logPath = join(dshHome, 'dsh-skills-manager', 'dsh-skills-manager.log')

const USER_ROOT = 'dsh'
const PROJECT_SKILL = 'probe-proj-dsh'
const AGENTS_SKILL = 'probe-proj-agents'
const SHADOW = 'probe-shadow'
const failures = []

/**
 * 起一个真实会话，取回两份视图。
 *
 * 两份都要看，因为它们回答的是不同的问题：
 *   - `registry`：本插件从注册表读到的该 agent 的裁决结果；
 *   - `prompt`：**模型真正收到的那份目录**（系统提示里的技能清单）。
 * 前者是插件的自我认知，后者才是事实。两者不一致就说明插件在骗人 —— 这轮就是这么发现
 * 项目根漏报的：注册表视图里没有项目技能，而系统提示里明明列着。
 * @param {string} cwd - 会话工作目录
 * @returns {Promise<{ registry: string[], prompt: string }>} 两份视图
 */
async function sessionView(cwd) {
  const before = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').length : 0
  const dump = join(tmpdir(), `dshsm-frames-${Date.now()}.jsonl`)
  await run(process.execPath, [join(here, 'session-probe.mjs'), '--cwd', cwd, '--dump', dump], { timeout: 120000 })
  const lines = readFileSync(logPath, 'utf8').split('\n').slice(before)
  const hit = lines.filter((line) => line.includes('scope-snapshot')).pop()
  if (!hit) throw new Error(`没有拿到 scope-snapshot（cwd=${cwd}）—— 会话可能没建立起来`)
  const registry = (JSON.parse(hit).detail.split('——')[1] ?? '').split('、').map((item) => item.trim()).filter(Boolean)
  const prompt = existsSync(dump) ? readFileSync(dump, 'utf8') : ''
  rmSync(dump, { force: true })
  return { registry, prompt }
}

/**
 * 断言并记录。
 * @param {boolean} ok - 是否通过
 * @param {string} label - 描述
 * @param {unknown} [detail] - 附加信息
 */
function check(ok, label, detail) {
  console.log(`${ok ? '  ✔' : '  ✖'} ${label}${detail === undefined ? '' : ` —— ${detail}`}`)
  if (!ok) failures.push(label)
}

const project = join(tmpdir(), `dshsm-proj-${Date.now()}`)
mkdirSync(join(project, '.git'), { recursive: true })
mkdirSync(join(project, '.dsh', 'skills', PROJECT_SKILL), { recursive: true })
mkdirSync(join(project, '.agents', 'skills', AGENTS_SKILL), { recursive: true })
mkdirSync(join(project, '.dsh', 'skills', SHADOW), { recursive: true })
mkdirSync(join(dshHome, 'skills', SHADOW), { recursive: true })
writeFileSync(join(project, '.dsh', 'skills', PROJECT_SKILL, 'SKILL.md'), `---\nname: ${PROJECT_SKILL}\ndescription: 项目根的临时技能\n---\n\n正文\n`)
writeFileSync(join(project, '.agents', 'skills', AGENTS_SKILL, 'SKILL.md'), `---\nname: ${AGENTS_SKILL}\ndescription: 项目 agents 根的临时技能\n---\n\n正文\n`)
writeFileSync(
  join(project, '.dsh', 'skills', SHADOW, 'SKILL.md'),
  `---\nname: ${SHADOW}\ndescription: 项目版（应当胜出）\ndisable-model-invocation: true\n---\n\n项目正文\n`,
)
writeFileSync(join(dshHome, 'skills', SHADOW, 'SKILL.md'), `---\nname: ${SHADOW}\ndescription: 用户版（应当被遮蔽）\n---\n\n用户正文\n`)

console.log(`临时项目：${project}\n`)

try {
  console.log('1) 会话的工作目录就是该项目时')
  const inProject = await sessionView(project)
  check(inProject.registry.includes(PROJECT_SKILL), '.dsh/skills 下的项目技能进入了会话的注册表视图')
  check(inProject.registry.includes(AGENTS_SKILL), '.agents/skills 下的项目技能进入了会话的注册表视图')
  check(inProject.prompt.includes(PROJECT_SKILL), '项目技能出现在**模型收到的系统提示**里')
  check(inProject.prompt.includes(AGENTS_SKILL), '项目 agents 技能也出现在系统提示里')
  check(
    inProject.registry.includes(`${SHADOW}（模型不可用）`),
    '同名时项目版胜出（rank 100 胜过 400）',
    inProject.registry.find((item) => item.startsWith(SHADOW)) ?? '（没这条）',
  )

  console.log('\n2) 会话的工作目录不在该项目里时')
  const outside = await sessionView(here)
  check(outside.registry.includes(PROJECT_SKILL) === false, '换了工作目录后项目技能不该出现')
  check(outside.prompt.includes(PROJECT_SKILL) === false, '模型收到的目录里也不该有它')
  check(outside.registry.includes(SHADOW), '同名技能此时由用户版提供')
  check(outside.registry.includes(`${SHADOW}（模型不可用）`) === false, '用户版没有被 disable，应当可用')

  console.log('\n3) 对项目根的技能做启停')
  const { createRuntime } = await import('../lib/index.js')
  const runtime = createRuntime({ dshHome, log: false })
  const catalog = runtime.catalogFor(project)
  const winner = catalog.winners.get(PROJECT_SKILL)
  check(winner !== undefined && winner.rootKey.startsWith('project-dsh@'), '项目技能在目录里以项目根胜出', winner?.rootKey)
  const disabled = runtime.setEnabled({ rootKey: winner.rootKey, name: PROJECT_SKILL, enabled: false, cwd: project })
  check(disabled.ok === true, '停用项目技能成功', JSON.stringify(disabled.error ?? ''))

  const afterDisable = await sessionView(project)
  check(
    afterDisable.registry.includes(`${PROJECT_SKILL}（模型不可用）`),
    '新会话里它变成模型不可用 —— 启停对项目根同样生效',
    afterDisable.registry.find((item) => item.startsWith(PROJECT_SKILL)) ?? '（没这条）',
  )
  check(afterDisable.prompt.includes(PROJECT_SKILL) === false, '被停用后，模型收到的目录里已经没有它了')
  check(
    readFileSync(join(project, '.dsh', 'skills', PROJECT_SKILL, 'SKILL.md'), 'utf8').includes('disable-model-invocation') === false,
    '源文件仍然没有被改动',
  )

  runtime.setEnabled({ rootKey: winner.rootKey, name: PROJECT_SKILL, enabled: null, cwd: project })
  check(runtime.state.overrides[winner.rootKey]?.[PROJECT_SKILL] === undefined, '覆盖已清除')
} finally {
  console.log('\n4) 清理')
  rmSync(project, { recursive: true, force: true })
  rmSync(join(dshHome, 'skills', SHADOW), { recursive: true, force: true })
  check(existsSync(project) === false, '临时项目已删除')
  check(existsSync(join(dshHome, 'skills', SHADOW)) === false, '用户侧的临时同名技能已删除')
}

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

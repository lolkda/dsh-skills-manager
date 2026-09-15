/**
 * 直接调用本插件的策略接口修改启停，供离线验收脚本使用。
 *
 * 为什么不直接手写 `state.json`：那样绕过了插件自己的校验与规范化，验证的就不再是插件的
 * 真实行为。这里 `createRuntime()` + `setEnabled()` 走的正是 HTTP 路由背后那同一段代码。
 *
 * 用法：node spike/policy-set.mjs <技能名> <enable|disable|clear> [--cwd <目录>] [--home <DSH_HOME>]
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import { createRuntime } from '../lib/index.js'

const args = process.argv.slice(2)
const name = args[0]
const action = args[1]
const value = (flag, fallback) => {
  const index = args.indexOf(`--${flag}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

if (!name || !['enable', 'disable', 'clear'].includes(action)) {
  console.error('用法：node spike/policy-set.mjs <技能名> <enable|disable|clear> [--cwd <目录>] [--home <DSH_HOME>]')
  process.exit(2)
}

const cwd = value('cwd', process.cwd())
const dshHome = value('home', join(homedir(), '.dsh'))
const runtime = createRuntime({ dshHome, log: false })

// 先看这个技能在当前组合里实际由哪个根胜出 —— rootKey 必须与裁决结果一致，
// 否则插件会如实返回 skill.shadowed，而不是假装改成功了。
const catalog = runtime.catalogFor(cwd)
const winner = catalog.winners.get(name)
if (!winner) {
  console.error(`找不到名为 ${name} 的生效技能。当前生效：${catalog.skills.filter((s) => s.winner).map((s) => s.name).join('、')}`)
  process.exit(1)
}

const enabled = action === 'clear' ? null : action === 'enable'
const result = runtime.setEnabled({ rootKey: winner.rootKey, name, enabled, cwd })
console.log(`${action} ${name} (rootKey=${winner.rootKey}) → ${JSON.stringify(result)}`)
process.exit(result.ok ? 0 : 1)

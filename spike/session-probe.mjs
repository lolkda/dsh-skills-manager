/**
 * 用一个真实的 headless 会话来验证「启停是否作用到会话」。
 *
 * 为什么需要它：插件的 `/registry` 读的是**宿主层**，而真实技能由 preset 层提供，
 * 宿主层本来就是空的 —— 那条路无论启停有没有生效，看到的都是同一幅画面。要证明"作用到
 * 会话"，就必须真的有一个 agent 被创建出来。
 *
 * `sdk-minimal` profile 刻意排除 skills，用不了。但 `dsh-sdk-app` 的注释写明它是
 * "over dsh-base"，而 `dsh-base` 正好挂载 skill / skill-filesystem / tool-skill ——
 * 于是 `dsh-base + dsh-sdk-app` 就是一个**带 skills 的 headless agent**。
 *
 * 这一层还有个便宜可占：`dsh-sdk-jsonrpc-server` 的 initialize 在
 * `provider === 'deepseek-official'` 时会自己挂上 DeepSeek 适配器，所以不需要额外装适配器包，
 * 也不需要可用的 API key —— 会话建立（以及随之而来的 `agent/created`）在模型调用之前就发生了。
 *
 * 用法：node spike/session-probe.mjs [--model deepseek-chat] [--cwd <dir>] [--session <id>]
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** DSH 安装位置（npx 缓存）。 */
const DSH_BIN = 'C:/Users/Administrator/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh/lib/bin.js'

/**
 * 解析命令行参数。
 * @returns {object} 选项
 */
function options() {
  const args = process.argv.slice(2)
  const value = (name, fallback) => {
    const index = args.indexOf(`--${name}`)
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback
  }
  return {
    model: value('model', 'deepseek-chat'),
    cwd: value('cwd', process.cwd()),
    session: value('session', `session-probe-${Date.now()}`),
    profile: value('profile', 'skillprobe'),
    settleMs: Number(value('settle', '9000')),
  }
}

const opts = options()
const dshHome = join(homedir(), '.dsh')
mkdirSync(join(dshHome, 'dsh-skills-manager'), { recursive: true })

const child = spawn(process.execPath, [DSH_BIN, '--profile', opts.profile], {
  cwd: join(dshHome, 'profiles', opts.profile),
  env: { ...process.env, DSH_HOME: dshHome },
  stdio: ['pipe', 'pipe', 'pipe'],
})

const frames = []
let buffer = ''
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let index = buffer.indexOf('\n')
  while (index >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      try {
        frames.push(JSON.parse(line))
      } catch {
        frames.push({ __unparsed: line })
      }
    }
    index = buffer.indexOf('\n')
  }
})
const stderr = []
child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')))

/**
 * 发一帧 JSON-RPC。
 * @param {object} frame - 帧
 */
function send(frame) {
  child.stdin.write(`${JSON.stringify(frame)}\n`)
}

/**
 * 等某个 id 的响应。
 * @param {number} id - 请求 id
 * @param {number} timeoutMs - 超时
 * @returns {Promise<object|null>} 响应
 */
async function awaitResponse(id, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = frames.find((frame) => frame.id === id)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await sleep(4000)
  console.log(`[probe] 启动后已收到 ${frames.length} 帧`)

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: opts.cwd, provider: 'deepseek-official', model: opts.model } })
  const init = await awaitResponse(1, 20000)
  console.log(`[probe] initialize → ${JSON.stringify(init)}`)
  if (!init || init.error) {
    console.log('[probe] 初始化未成功，不再继续')
  } else {
    send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: opts.session, contentBlocks: [{ type: 'text', text: 'ping' }] } })
    const prompt = await awaitResponse(2, 20000)
    console.log(`[probe] session/prompt → ${JSON.stringify(prompt)}`)
    console.log(`[probe] 等待 ${opts.settleMs}ms 让会话建立并跑完第一步`)
    await sleep(opts.settleMs)
  }

  send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} })
  await awaitResponse(3, 5000)
} finally {
  await sleep(500)
  child.kill()
  console.log(`[probe] 会话 id: ${opts.session}`)
  console.log(`[probe] 通知/事件帧数: ${frames.filter((frame) => frame.method).length}`)
  const methods = [...new Set(frames.filter((frame) => frame.method).map((frame) => frame.method))]
  console.log(`[probe] 收到的方法: ${methods.join(', ') || '（无）'}`)
  const errors = stderr.join('').split('\n').filter((line) => /error|Error|failed|失败/.test(line))
  if (errors.length > 0) console.log(`[probe] stderr 中的错误行:\n${errors.slice(0, 8).join('\n')}`)
}

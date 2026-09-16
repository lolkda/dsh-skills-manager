/**
 * 真实浏览器验收：在 Chrome 里把 DSH 的 Web 界面真的打开一次，看技能面板在**真实 DOM** 里
 * 长什么样。
 *
 * 为什么还要这一层：前几轮客户端都是用自写的 mini React 运行时测的 —— 那能证明"服务端送出的
 * 字节能注册出面板"，但证明不了真实 React、真实 DOM、真实插件加载器这一整套跑起来的结果。
 * 用户最终看到的是后者。
 *
 * 不依赖任何 npm 包：Node 24 自带 WebSocket，CDP 就是一个 WebSocket 上的 JSON-RPC。
 * 用独立的 `--user-data-dir` 起 Chrome，不碰用户正在用的那个实例。
 *
 * 用法：node spike/browser-probe.mjs [--base http://127.0.0.1:3099] [--log <启动日志>] [--keep-open]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME_CANDIDATES = [
  join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Microsoft/Edge/Application/msedge.exe'),
]

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(`--${flag}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = value('base', 'http://127.0.0.1:3099')
const logPath = value('log', '')
const keepOpen = args.includes('--keep-open')
const toggleTarget = value('toggle', '')
const DEBUG_PORT = Number(value('port', '9333'))

const failures = []
const notes = []

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

/**
 * 一个够用的 CDP 客户端。
 */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.sequence = 0
    this.pending = new Map()
    this.events = []
    socket.onmessage = (event) => this.#receive(String(event.data))
  }

  /**
   * 连到一个 CDP WebSocket。
   * @param {string} url - WebSocket 地址
   * @returns {Promise<Cdp>} 客户端
   */
  static async connect(url) {
    const socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      socket.onopen = resolve
      socket.onerror = () => reject(new Error(`连不上 CDP：${url}`))
    })
    return new Cdp(socket)
  }

  #receive(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message ?? 'CDP 调用失败'))
      else resolve(message.result)
      return
    }
    if (message.method) this.events.push(message)
  }

  /**
   * 发一条 CDP 命令。
   * @param {string} method - 方法
   * @param {object} [params] - 参数
   * @returns {Promise<object>} 结果
   */
  send(method, params = {}) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /**
   * 在页面里求值。
   * @param {string} expression - 表达式
   * @returns {Promise<unknown>} 值
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? '页面求值抛错')
    }
    return result.result.value
  }
}

/**
 * 轮询直到表达式为真。
 * @param {Cdp} cdp - 客户端
 * @param {string} expression - 表达式
 * @param {number} [timeoutMs] - 超时
 * @param {string} [label] - 描述
 * @returns {Promise<boolean>} 是否成功
 */
async function waitFor(cdp, expression, timeoutMs = 20000, label = expression) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await cdp.evaluate(expression)) return true
    } catch {
      // 页面还在导航，下一轮再看。
    }
    if (Date.now() > deadline) {
      notes.push(`等待超时：${label}`)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

const chrome = CHROME_CANDIDATES.find((path) => path && existsSync(path))
if (!chrome) {
  console.log('机器上找不到 Chrome / Edge，跳过浏览器验收。')
  process.exit(0)
}
console.log(`浏览器：${chrome}`)

let token = ''
const logs = [logPath, process.env.DSH_PROBE_LOG].filter(Boolean)
for (const path of logs) {
  try {
    token = /token=([A-Za-z0-9_-]+)/.exec(readFileSync(path, 'utf8'))?.[1] ?? token
  } catch {
    // 继续找下一个。
  }
}
check(token.length > 0, '从启动日志里取到访问 token')

const profileDir = mkdtempSync(join(tmpdir(), 'dshsm-chrome-'))
const child = spawn(
  chrome,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--window-size=1600,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let cdp
try {
  // 等调试端点起来。
  let targets
  for (let i = 0; i < 60; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
      if (Array.isArray(targets) && targets.some((item) => item.type === 'page')) break
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const page = (targets ?? []).find((item) => item.type === 'page')
  check(page !== undefined, 'Chrome 的调试端点可用')
  if (!page) throw new Error('没有可用的页面目标')

  cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Log.enable')
  // 记下真实发出的请求，才能证明"点了开关"确实打出了策略请求，而不只是界面动了一下。
  await cdp.send('Network.enable')

  console.log('\n打开界面')
  // 真实浏览器走一遍 token 换 cookie + 跳转，和用户点开链接的路径一致。
  await cdp.send('Page.navigate', { url: `${base}/?token=${token}` })
  const booted = await waitFor(cdp, 'document.readyState === "complete"', 25000, '页面加载完成')
  check(booted, '页面加载完成')

  // 客户端插件由加载器动态注入，等它真的跑起来。
  const loaded = await waitFor(
    cdp,
    'document.querySelectorAll("style[data-plugin]").length > 0 || document.body.innerText.length > 50',
    25000,
    '应用挂载',
  )
  check(loaded, '应用挂载完成')

  const summary = await cdp.evaluate(`(() => {
    const styles = Array.from(document.querySelectorAll('style[data-plugin]')).map((el) => el.dataset.plugin)
    return {
      title: document.title,
      textLength: document.body.innerText.length,
      pluginStyles: styles,
      hasOurStyle: styles.includes('dsh-skills-manager'),
      shell: typeof window.__ModuleLoader__,
      scripts: document.querySelectorAll('script[src*="/plugins/"]').length,
    }
  })()`)
  console.log(`     标题：${summary.title}`)
  console.log(`     页面文本长度：${summary.textLength}`)
  check(summary.shell !== 'undefined', '页面里的模块加载器存在')
  check(summary.hasOurStyle, '本插件的样式注入到了真实 DOM 里', `已注入的插件样式：${summary.pluginStyles.join(', ') || '（无）'}`)

  console.log('\n打开设置，找技能面板')
  // 设置入口由 dsh-client-ui-layout 渲染。先看看页面上到底有哪些可点的东西，
  // 免得"点到了某个含『设置』的元素"就当成打开成功。
  const clickables = await cdp.evaluate(`Array.from(document.querySelectorAll('button, [role="button"], a'))
    .map((el) => (el.innerText || el.getAttribute('aria-label') || el.title || '').trim())
    .filter(Boolean).slice(0, 60)`)
  console.log(`     页面可点文案：${clickables.join(' | ') || '（无）'}`)

  const opened = await cdp.evaluate(`(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
    const target = candidates.find((el) => /设置|Settings/i.test(el.innerText || el.getAttribute('aria-label') || el.title || ''))
    if (!target) return { clicked: false }
    target.click()
    return { clicked: true, label: (target.innerText || target.getAttribute('aria-label') || '').trim() }
  })()`)
  check(opened.clicked, '点得到设置入口', opened.label)
  if (!opened.clicked) throw new Error('页面上没有设置入口')

  await new Promise((resolve) => setTimeout(resolve, 1200))
  const afterOpen = await cdp.evaluate(`({
    text: document.body.innerText.slice(0, 1500),
    entries: Array.from(document.querySelectorAll('button, [role="button"], a, li, [class*="item"], [class*="nav"]'))
      .map((el) => (el.innerText || '').trim()).filter((t) => t && t.length < 40).slice(0, 60),
  })`)
  console.log(`     打开设置后的正文：${JSON.stringify(afterOpen.text.slice(0, 500))}`)
  notes.push(`设置里的条目：${(afterOpen.entries ?? []).join(' | ')}`)

  // settings.section 是**列表型**槽：先打开设置，再点里面的「技能」条目。
  const entered = await cdp.evaluate(`(() => {
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, [class*="item"]'))
    const target = nodes.find((el) => (el.innerText || '').trim() === '技能')
    if (!target) return { clicked: false }
    target.click()
    return { clicked: true }
  })()`)
  check(entered.clicked, '设置里找得到「技能」条目')

  const panelReady = await waitFor(cdp, 'document.querySelector(".dshsm-section") !== null', 15000, '技能面板出现')
  check(panelReady, '技能面板出现')

  // 面板出现还不够 —— 要看它里面**真的有技能**，而且是真实数据。
  const rowsReady = await waitFor(cdp, 'document.querySelectorAll(".dshsm-row").length > 0', 20000, '技能行渲染出来')
  check(rowsReady, '技能行渲染出来了')

  const panel = await cdp.evaluate(`(() => {
    const section = document.querySelector('.dshsm-section')
    return {
      hasSection: section !== null,
      tabLabels: Array.from(document.querySelectorAll('.dshsm-tab')).map((el) => el.innerText.trim()),
      names: Array.from(document.querySelectorAll('.dshsm-name')).map((el) => el.innerText.trim()),
      rows: document.querySelectorAll('.dshsm-row').length,
      toggles: document.querySelectorAll('.dshsm-row input[type=checkbox], .dshsm-row [role=switch]').length,
      scopeLine: document.querySelector('.dshsm-scope') ? document.querySelector('.dshsm-scope').innerText.trim() : '',
      notice: document.querySelector('.dshsm-notice') ? document.querySelector('.dshsm-notice').innerText.trim() : '',
      text: section ? section.innerText.slice(0, 700) : '',
    }
  })()`)

  check(panel.hasSection, '真实 DOM 里存在 .dshsm-section')
  check(panel.names.length > 0, '读到了技能名', panel.names.slice(0, 8).join('、'))
  check(panel.tabLabels.length >= 2, '标签页（技能 / 回收站）在', panel.tabLabels.join(' / '))
  check(panel.scopeLine.length > 0, '显示了项目根的解析依据', panel.scopeLine.slice(0, 120))
  if (panel.notice) notes.push(`面板提示：${panel.notice.slice(0, 200)}`)
  console.log(`     面板正文：${JSON.stringify(panel.text.slice(0, 400))}`)

  if (toggleTarget) {
    console.log(`\n在真实 DOM 里点「${toggleTarget}」的开关`)
    const before = await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.dshsm-row'))
        .find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(toggleTarget)})
      if (!row) return null
      const sw = row.querySelector('[role=switch]')
      return sw ? { checked: sw.getAttribute('aria-checked'), disabled: sw.disabled, label: sw.getAttribute('aria-label'), title: sw.title } : null
    })()`)
    check(before !== null, '找得到这一行的开关', before ? `aria-checked=${before.checked}` : '没找到')
    if (!before) throw new Error(`面板里没有技能 ${toggleTarget}`)
    if (before.disabled) throw new Error(`技能 ${toggleTarget} 的开关是禁用的：${before.title ?? ''}`)

    const mark = cdp.events.length
    const clicked = await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.dshsm-row'))
        .find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(toggleTarget)})
      const sw = row.querySelector('[role=switch]')
      sw.click()
      return true
    })()`)
    check(clicked === true, '点击开关')

    // 等请求真的发出去，并且状态翻转回来。
    const flipped = await waitFor(
      cdp,
      `(() => {
        const row = Array.from(document.querySelectorAll('.dshsm-row'))
          .find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(toggleTarget)})
        const sw = row && row.querySelector('[role=switch]')
        return sw ? sw.getAttribute('aria-checked') !== ${JSON.stringify(before.checked)} : false
      })()`,
      15000,
      '开关状态翻转',
    )
    check(flipped, '界面上的开关状态翻转过来了', `${before.checked} → 反`)

    const requests = cdp.events
      .slice(mark)
      .filter((event) => event.method === 'Network.requestWillBeSent' && /dsh-skills-manager\/policy/.test(event.params?.request?.url ?? ''))
      .map((event) => ({ url: event.params.request.url, method: event.params.request.method, body: event.params.request.postData }))
    check(requests.length > 0, '真的打出了策略请求', requests.map((item) => `${item.method} ${item.url.split('?')[0]}`).join(', ') || '没有')
    if (requests.length > 0) {
      console.log(`     请求体：${requests[requests.length - 1].body ?? '（空）'}`)
      console.log(`     开关无障碍名：${before.label ?? '（无）'}`)
    }

    const after = await cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.dshsm-row'))
        .find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(toggleTarget)})
      const notice = document.querySelector('.dshsm-notice')
      return {
        pills: row ? Array.from(row.querySelectorAll('.dshsm-pill')).map((el) => el.innerText.trim()) : [],
        notice: notice ? notice.innerText.trim() : '',
        tabs: Array.from(document.querySelectorAll('.dshsm-tab')).map((el) => el.innerText.trim()),
      }
    })()`)
    console.log(`     该行的标签：${after.pills.join(' / ') || '（无）'}`)
    console.log(`     标签页：${after.tabs.join(' / ')}`)
    if (after.notice) notes.push(`操作后的提示：${after.notice.slice(0, 200)}`)
  }

  console.log('\n看看有没有 JS 报错')
  const errors = cdp.events
    .filter((event) => event.method === 'Runtime.exceptionThrown' || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
    .map((event) => event.params?.exceptionDetails?.exception?.description ?? event.params?.entry?.text ?? '')
    .filter((text) => text && !/favicon/i.test(text))
  check(errors.length === 0, '页面没有报错', errors.slice(0, 3).join(' | ') || '（无）')
} catch (error) {
  check(false, `浏览器验收中断：${error instanceof Error ? error.message : String(error)}`)
} finally {
  if (keepOpen) {
    console.log(`\nChrome 保持运行：http://127.0.0.1:${DEBUG_PORT}/json/list（user-data-dir=${profileDir}）`)
  } else {
    try {
      cdp?.socket.close()
    } catch {
      // 已经断了。
    }
    // 必须等主进程**真的退出**再删 profile 目录：Chrome 会拉起一堆子进程，
    // 它们还占着目录时 rmSync 报 EPERM，于是每跑一次就留下一个几十兆的临时目录。
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))])
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 700))
      }
    }
    if (existsSync(profileDir)) notes.push(`临时 profile 没能删掉，需要手工清：${profileDir}`)
  }
}

if (notes.length > 0) {
  console.log('\n备注：')
  for (const note of notes) console.log(`  · ${note}`)
}
console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

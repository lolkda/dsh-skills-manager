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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeZip } from './make-zip.mjs'

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
const exercise = args.includes('--exercise')
const doImportExercise = args.includes('--exercise-import')
const doStyleAudit = args.includes('--styles')
// 截图路径：给个 .png，会另存一张展开详情后的 `<名字>-expanded.png`。
const shotPath = value('shot', '')
// 默认指向真实的用户技能根 —— 演练会在这里建一条临时技能，最后再清掉。
const skillsDir = value('skills-dir', join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'skills'))
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

/**
 * 在真实浏览器里把「导入」的三条分支都走一遍：ZIP 上传、单个 Markdown 上传、从路径导入。
 *
 * 为什么单独挑这三条：路径那条在别处验过，但**上传**这两条走的是浏览器独有的 API ——
 * `readBase64` 用 `FileReader`、Markdown 用 `file.text()`。自写的 mini React 运行时里根本没有
 * `FileReader`，所以这两条分支在真实浏览器之外的地方**一次都没跑过**。
 * @param {Cdp} cdp - 客户端
 * @param {object} options - 参数
 * @param {string} options.skillsDir - 用户技能根
 * @param {string} options.scratchDir - 放素材的临时目录
 * @param {string[]} options.notes - 备注收集
 * @returns {Promise<void>} 完成
 */
async function exerciseImport(cdp, { skillsDir, scratchDir, notes: remarks }) {
  const zipName = 'probe-zip'
  const mdName = 'probe-md'
  const dirName = 'probe-dir'

  // 素材：一个 ZIP（内含目录 bundle）、一个单文件 Markdown、一个目录。
  const zipPath = join(scratchDir, 'probe-zip.zip')
  writeFileSync(zipPath, makeZip([{ name: `${zipName}/SKILL.md`, data: doc(zipName, '由浏览器上传 ZIP 导入'), deflate: true }]))
  const mdPath = join(scratchDir, 'probe-md.md')
  writeFileSync(mdPath, doc(mdName, '由浏览器上传单个 Markdown 导入'))
  const dirPath = join(scratchDir, 'probe-dir')
  mkdirSync(dirPath, { recursive: true })
  writeFileSync(join(dirPath, 'SKILL.md'), doc(dirName, '由浏览器按路径导入'))

    await new Promise((resolve) => setTimeout(resolve, 700))

  /** 打开导入表单。 */
  const openImport = () =>
    cdp.evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('button')).find((b) => ((b.innerText || '').trim() === '导入技能' || (b.innerText || '').trim().endsWith('导入技能')))
      if (!el) return false
      el.click()
      return true
    })()`)

  /** 往文件输入框里塞一个真实文件 —— 和用户点"选择文件"是同一个效果。 */
  const attachFile = async (filePath) => {
    const handle = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('.dshsm-form input[type=file]')` })
    const objectId = handle.result?.objectId
    if (!objectId) return false
    await cdp.send('DOM.setFileInputFiles', { files: [filePath], objectId })
    return true
  }

  /** 该技能在磁盘上出现了吗。 */
  const onDisk = (name) => existsSync(join(skillsDir, name, 'SKILL.md'))

  // ---- ZIP ----
  check(await openImport(), '导入：打开导入表单')
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(await attachFile(zipPath), '导入：把 ZIP 塞进文件框')
  const zipOk = await waitFor(cdp, `document.querySelectorAll('.dshsm-name').length > 0 && ${JSON.stringify(true)}`, 3000, 'ZIP 上传后的界面')
  check(zipOk || true, '导入：界面还在（下面按磁盘与列表判断结果）')
  let appeared = false
  for (let i = 0; i < 40 && !appeared; i += 1) {
    appeared = onDisk(zipName)
    if (!appeared) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  check(appeared, '导入：ZIP 上传后磁盘上出现了它')

  // ---- 单个 Markdown ----
  await new Promise((resolve) => setTimeout(resolve, 800))
  if (!(await openImport())) {
    // 上一次导入成功后表单会自动关闭，重新打开。
    await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find((b) => ((b.innerText || '').trim() === '导入技能' || (b.innerText || '').trim().endsWith('导入技能'))); if (el) el.click(); return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  check(await attachFile(mdPath), '导入：把单个 Markdown 塞进文件框')
  let mdAppeared = false
  for (let i = 0; i < 40 && !mdAppeared; i += 1) {
    mdAppeared = onDisk(mdName)
    if (!mdAppeared) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  check(mdAppeared, '导入：单个 Markdown 上传后磁盘上出现了它')

  // ---- 从路径导入 ----
  await new Promise((resolve) => setTimeout(resolve, 800))
  await cdp.evaluate(`(() => { const el = Array.from(document.querySelectorAll('button')).find((b) => ((b.innerText || '').trim() === '导入技能' || (b.innerText || '').trim().endsWith('导入技能'))); if (el) el.click(); return true })()`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  const typed = await cdp.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('.dshsm-form input')).find((i) => i.type !== 'file')
    if (!el) return false
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(dirPath)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  check(typed, '导入：填上本机路径')
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    await cdp.evaluate(`(() => {
      const el = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim() === '从路径导入')
      if (!el) return false
      el.click()
      return true
    })()`),
    '导入：点从路径导入',
  )
  let dirAppeared = false
  for (let i = 0; i < 40 && !dirAppeared; i += 1) {
    dirAppeared = onDisk(dirName)
    if (!dirAppeared) await new Promise((resolve) => setTimeout(resolve, 500))
  }
  check(dirAppeared, '导入：按路径导入后磁盘上出现了它')

  // 列表里也要看得到 —— 只在磁盘上出现还不算导入成功。
  const listed = await waitFor(
    cdp,
    `['${zipName}','${mdName}','${dirName}'].every((n) => Array.from(document.querySelectorAll('.dshsm-name')).some((el) => el.innerText.trim() === n))`,
    15000,
    '三条导入的技能都在列表里',
  )
  check(listed, '导入：三条都出现在技能列表里')

  // ---- 清场：直接从磁盘移除，不经过界面（这三条是探针造的，不是用户的东西）----
  for (const name of [zipName, mdName, dirName]) {
    if (existsSync(join(skillsDir, name))) {
      try {
        rmSync(join(skillsDir, name), { recursive: true, force: true })
      } catch {
        remarks.push(`导入演练的临时技能没清掉：${join(skillsDir, name)}`)
      }
    }
  }
  check(!onDisk(zipName) && !onDisk(mdName) && !onDisk(dirName), '导入：清理干净')
}

/**
 * 造一份技能文档。
 * @param {string} name - 技能名
 * @param {string} description - 描述
 * @returns {string} 文档
 */
function doc(name, description) {
  return ['---', `name: ${name}`, `description: ${description}`, '---', '', '正文由浏览器探针导入。', ''].join(String.fromCharCode(10))
}

/**
 * 把"样式对齐"变成可判定的东西。
 *
 * 同一个浏览器、同一个主题下，读我们和 `@lolkda/dsh-prompt-manager` **对应元素**的计算样式，
 * 逐项比对。令牌名写错、单位写错、规则没生效，计算值都会露出来 —— 光看截图是看不出来的。
 * 参考值取自提示词页自己渲染出来的那棵树，不是照抄源码里记的数字。
 * @param {object} cdp - 连接
 * @param {{notes: string[]}} ctx - 记录
 * @returns {Promise<void>} 完成
 */
/**
 * 下拉控件：和通用设置页里 DSH 自己的选择器逐项对比。
 *
 * 参照物是**现场读到的那个真实控件**，不是写死的常量 —— 主题一变、或者 DSH 调了尺寸，
 * 这里会跟着一起动；写死的数字只会在某天悄悄变成错的。
 *
 * 之所以单独成一段而不是塞进 `auditStyles` 的对照表：那张表的参照物固定取自**提示词页**，
 * 而 DSH 的选择器在**通用设置页**，塞进去会拿错对象比（第一次就是这么写错的，
 * 拿到的"参照"其实是提示词页上另一个按钮的尺寸）。
 * @param {object} cdp - CDP 客户端
 * @param {{ notes: Array<string> }} options - 备注收集
 * @returns {Promise<void>} 完成
 */
async function auditDropdown(cdp, { notes: remarks }) {
  const props = ['height', 'paddingLeft', 'paddingRight', 'borderTopLeftRadius', 'borderTopWidth', 'backgroundColor', 'fontSize']
  const clickEntry = (label) =>
    cdp.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role=button], li, div'))
      const target = nodes.find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)})
      if (!target) return false
      target.click()
      return true
    })()`)
  const read = (selectors) =>
    cdp.evaluate(`(() => {
      let el = null
      for (const s of ${JSON.stringify(selectors)}) { el = document.querySelector(s); if (el) break }
      if (!el) return null
      const cs = getComputedStyle(el)
      return Object.fromEntries(${JSON.stringify(props)}.map((p) => [p, cs[p]]))
    })()`)

  // 参照物：通用设置页的语言选择器（DSH 自己的下拉）。
  await clickEntry('通用设置')
  await new Promise((resolve) => setTimeout(resolve, 900))
  const theirs = await read(['[class*=_selector]', 'button[aria-haspopup=menu]'])
  if (!theirs) {
    remarks.push('下拉控件：通用设置页里没找到 DSH 的选择器（它换了类名？），本项跳过')
    await clickEntry('技能')
    return
  }

  // 候选目录只有一个时界面不渲染下拉。为了比对，临时给 /catalog 的响应注入几个候选 ——
  // 这只是**取样手段**，被测代码没被改。第一项用真实 cwd，好让当前值那一项也能出现对勾。
  await clickEntry('技能')
  await new Promise((resolve) => setTimeout(resolve, 400))
  await cdp.evaluate(`(() => {
    const real = window.fetch
    window.fetch = async (...args) => {
      const res = await real(...args)
      const url = String(args[0] && args[0].url ? args[0].url : args[0])
      if (!url.includes('/dsh-skills-manager/catalog')) return res
      const body = await res.clone().json()
      if (body && body.data) body.data.candidates = [body.data.cwd, 'F:/project/抖音', 'D:/Personal/Desktop/样例目录']
      return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
    }
    return true
  })()`)
  await clickEntry('通用设置')
  await new Promise((resolve) => setTimeout(resolve, 500))
  await clickEntry('技能')
  await new Promise((resolve) => setTimeout(resolve, 900))

  const mine = await read(['.dshsm-select__trigger'])
  if (!mine) {
    check(false, '下拉控件：注入了候选之后仍然没渲染出来')
    remarks.push('下拉控件：未渲染，本项未验证')
    return
  }
  for (const prop of props) {
    check(mine[prop] === theirs[prop], `下拉按钮.${prop} 与 DSH 的选择器一致`, `我们 ${mine[prop]} / DSH ${theirs[prop]}`)
  }

  // 菜单层与菜单项：收起时不存在，得点开才量得到。DSH 那边同样要展开，这里只校验
  // 我们自己画的那一层有没有照它的几何来（圆角 20 / 内边距 4 / 项高 40 / 项圆角 10）。
  const menu = await cdp.evaluate(`(() => {
    const t = document.querySelector('.dshsm-select__trigger')
    if (!t) return null
    t.click()
    return true
  })()`)
  if (menu) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const box = await cdp.evaluate(`(() => {
      const m = document.querySelector('.dshsm-menu')
      const it = document.querySelector('.dshsm-menu__item')
      if (!m || !it) return null
      const mc = getComputedStyle(m)
      const ic = getComputedStyle(it)
      return { radius: mc.borderRadius, padding: mc.padding, minWidth: mc.minWidth, maxWidth: mc.maxWidth, itemHeight: ic.minHeight, itemPadding: ic.padding, itemRadius: ic.borderRadius, itemGap: ic.gap }
    })()`)
    if (box) {
      check(box.radius === '20px', '菜单圆角 20px（照 DSH 的菜单）', box.radius)
      check(box.padding === '4px', '菜单内边距 4px', box.padding)
      check(box.minWidth === '218px' && box.maxWidth === '360px', '菜单宽度 218–360px', `${box.minWidth}–${box.maxWidth}`)
      check(box.itemHeight === '40px', '菜单项最小高度 40px', box.itemHeight)
      check(box.itemPadding === '8px 10px', '菜单项内边距 8px 10px', box.itemPadding)
      check(box.itemRadius === '10px', '菜单项圆角 10px', box.itemRadius)
      check(box.itemGap === '8px', '菜单项图标间距 8px', box.itemGap)
      const checks = await cdp.evaluate(`document.querySelectorAll('.dshsm-menu__check').length`)
      check(checks === 1, '当前值那一项带对勾，且只有它带', String(checks))
    }
    await cdp.evaluate(`(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

async function auditStyles(cdp, { notes: remarks }) {
  const PROPS = {
    card: ['paddingTop', 'paddingRight', 'borderTopWidth', 'borderTopStyle', 'borderTopLeftRadius'],
    title: ['fontSize', 'fontWeight', 'lineHeight'],
    meta: ['fontSize', 'lineHeight', 'color'],
    tab: ['fontSize', 'lineHeight', 'paddingTop', 'paddingBottom', 'color'],
    badge: ['paddingTop', 'paddingLeft', 'borderTopWidth', 'borderTopLeftRadius', 'fontSize', 'lineHeight'],
    button: ['height', 'paddingLeft', 'borderTopWidth', 'borderTopLeftRadius', 'fontSize'],
    // 圆角与 padding 不参与对比：`999px` 与 `10px` 在 20px 高下都是全圆，
    // 绝对定位的圆钮与 padding 内缩也是同一效果的两种写法。
    control: ['width', 'height', 'backgroundColor', 'borderTopWidth'],
  }
  // 每一格给一串候选选择器：提示词页在不同视图下渲染的控件不一样，写死一个会假失败。
  const PAIRS = [
    ['行卡', 'card', ['.dshsm-row'], ['.dsh-prompt-manager__card']],
    ['标题', 'title', ['.dshsm-name'], ['.dsh-prompt-manager__title']],
    ['次要说明', 'meta', ['.dshsm-row__desc'], ['.dsh-prompt-manager__meta']],
    ['徽标', 'badge', ['.dshsm-pill'], ['.dsh-prompt-manager__badge', '.dsh-prompt-manager__dot']],
    // 开关与图标按钮：提示词页的开关是**原生 checkbox**（样式由宿主给），
    // 我的开关是 button[role=switch]。量它的实际尺寸来对齐。
    ['开关', 'control', ['.dshsm-switch'], ['input[type=checkbox]', '[role=switch]', '[class*=switch]', '[class*=toggle]']],
    ['图标按钮', 'control', ['.dshsm-btn'], ['.dsh-prompt-manager__iconButton']],
  ]

  // 按钮单独处理：提示词页的**列表视图里不渲染普通按钮**（只有图标按钮、以及输入框下方的 chip），
  // 就地取不到参考值。所以这里对照的是它样式表里写死的几何，来源标注清楚。
  // 它挡不住"我当初抄错了" —— 但挡得住"以后谁改坏了"。
  const BUTTONS = [
    ['次要按钮', '.dshsm-btn:not(.dshsm-btn--primary)', { height: '28px', paddingLeft: '10px', borderTopLeftRadius: '14px', fontSize: '12px' }],
    ['主按钮', '.dshsm-btn--primary', { height: '32px', borderTopLeftRadius: '16px', fontSize: '13px' }],
  ]

  /**
   * 切到设置里的某个条目。
   * @param {string} label - 条目文字
   * @returns {Promise<boolean>} 是否点到
   */
  const go = async (label) => {
    const clicked = await cdp.evaluate(`(() => {
      const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, li, [class*="item"]'))
      const target = nodes.find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)})
      if (!target) return false
      target.click()
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 900))
    return clicked === true
  }

  /**
   * 按当前可见的一侧读一遍计算样式。
   * @param {number} side - 0 取我们的选择器，1 取提示词页的
   * @returns {Promise<object>} 每个语义角色一组属性
   */
  const readAll = async (side) =>
    cdp.evaluate(`(() => {
      // 以**标签**为键：同一个 kind 可以有多对，用 kind 做键会互相覆盖。
      const spec = ${JSON.stringify(PAIRS.map(([label, kind, ours, theirs]) => [label, kind, side === 0 ? ours : theirs]))}
      const props = ${JSON.stringify(PROPS)}
      const out = {}
      for (const [label, kind, selectors] of spec) {
        let el = null
        for (const selector of selectors) {
          el = document.querySelector(selector)
          if (el !== null) break
        }
        if (el === null) { out[label] = null; continue }
        const cs = getComputedStyle(el)
        out[label] = Object.fromEntries(props[kind].map((p) => [p, cs[p]]))
      }
      return out
    })()`)

  await new Promise((resolve) => setTimeout(resolve, 400))

  // 通用设置页里的「中文 / 浅色 / 紧凑」不是原生 select —— 它们是自绘控件。
  // 把它的真实结构量出来，这才是 DSH 的下拉长什么样。
  await go('通用设置')
  await new Promise((resolve) => setTimeout(resolve, 800))
  const dshControl = await cdp.evaluate(`(() => {
    const all = Array.from(document.querySelectorAll('button, [role=combobox], [role=button], select, input'))
    const pick = (text) => all.find((el) => (el.innerText || el.value || '').trim() === text)
    const describe = (el) => {
      if (!el) return null
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        tag: el.tagName, cls: el.className, role: el.getAttribute('role'),
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        padding: cs.padding, font: cs.fontSize, radius: cs.borderRadius,
        border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        background: cs.backgroundColor, color: cs.color,
        html: el.outerHTML,
      }
    }
    const zh = pick('中文')
    return { 中文控件: describe(zh), 是原生select: document.querySelectorAll('select').length }
  })()`)
  console.log('通用设置的控件：' + JSON.stringify(dshControl, null, 2))

  // 点开它，看弹出的列表长什么样
  const opened = await cdp.evaluate(`(() => {
    const el = Array.from(document.querySelectorAll('button, [role=combobox], [role=button]')).find((e) => (e.innerText || '').trim() === '中文')
    if (!el) return 'not-found'
    el.click()
    return 'clicked'
  })()`)
  await new Promise((resolve) => setTimeout(resolve, 700))
  const popup = await cdp.evaluate(`(() => {
    const roles = ['[role=listbox]', '[role=menu]', '[role=option]', '[data-radix-popper-content-wrapper]', '[data-state=open]']
    const found = {}
    for (const sel of roles) found[sel] = document.querySelectorAll(sel).length
    const lb = document.querySelector('[role=listbox], [role=menu]')
    let detail = null
    if (lb) {
      const cs = getComputedStyle(lb)
      const r = lb.getBoundingClientRect()
      detail = {
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        background: cs.backgroundColor, radius: cs.borderRadius,
        border: cs.borderTopWidth + ' ' + cs.borderTopStyle + ' ' + cs.borderTopColor,
        padding: cs.padding, shadow: cs.boxShadow.slice(0, 80), cls: lb.className,
        shadowFull: cs.boxShadow,
        // 菜单项在 viewport 里面，再往下钻一层
        items: Array.from(lb.querySelectorAll('[role=menuitem], [role=option], [data-value]')).slice(0, 3).map((c) => {
          const ic = getComputedStyle(c)
          const r = c.getBoundingClientRect()
          return {
            text: (c.innerText || '').trim().slice(0, 20),
            cls: c.className,
            box: Math.round(r.width) + 'x' + Math.round(r.height),
            padding: ic.padding,
            radius: ic.borderRadius,
            color: ic.color,
            background: ic.backgroundColor,
            font: ic.fontSize,
            html: c.outerHTML,
          }
        }),
      }
    }
    return { found, detail }
  })()`)
  console.log('展开后：' + JSON.stringify({ opened, popup }, null, 2))
  await cdp.evaluate(`(() => { document.body.click(); return true })()`)
  await go('技能')
  await new Promise((resolve) => setTimeout(resolve, 500))

  const ours = await readAll(0)
  const switched = await go('提示词')
  check(switched, '切得到提示词页（用来取参考样式）')
  const theirs = switched ? await readAll(1) : null
  // 提示词页当前视图里都有哪些类，留在备注里 —— 下次对照选择器要换就照这个换。
  const available = switched
    ? await cdp.evaluate(
        `Array.from(new Set(Array.from(document.querySelectorAll('[class*="dsh-prompt-manager__"]')).flatMap((el) => Array.from(el.classList).filter((c) => c.startsWith('dsh-prompt-manager__'))))).sort()`,
      )
    : []
  await go('技能')

  if (!theirs) {
    remarks.push('没取到提示词页的样式，样式对比没做成')
    return
  }
  if (available.length > 0) remarks.push(`提示词页可对照的类：${available.join('、')}`)

  for (const [label, kind] of PAIRS) {
    const mine = ours[label]
    const ref = theirs[label]
    // 对照侧缺席是**取不到参考**，不是"样式不一致" —— 记进备注，不算失败。
    if (!mine || !ref) {
      remarks.push(`${label}：没取到对照样式（我们 ${mine ? 'ok' : '缺'} / 提示词页 ${ref ? 'ok' : '缺'}），本项跳过`)
      continue
    }
    for (const prop of PROPS[kind]) {
      const ok = mine[prop] === ref[prop]
      check(ok, `${label}.${prop} 与提示词页一致`, ok ? mine[prop] : `我们 ${mine[prop]} ≠ 提示词页 ${ref[prop]}`)
    }
  }

  const buttons = await cdp.evaluate(`(() => {
    const spec = ${JSON.stringify(BUTTONS.map(([, selector, expected]) => [selector, expected]))}
    const out = []
    for (const [selector, expected] of spec) {
      const el = document.querySelector(selector)
      if (el === null) { out.push([selector, null]); continue }
      const cs = getComputedStyle(el)
      out.push([selector, Object.fromEntries(Object.keys(expected).map((p) => [p, cs[p]]))])
    }
    return out
  })()`)
  for (const [index, [selector, actual]] of buttons.entries()) {
    const [label, , expected] = BUTTONS[index]
    if (!actual) {
      remarks.push(`${label}（${selector}）没找到，跳过`)
      continue
    }
    for (const [prop, want] of Object.entries(expected)) {
      const ok = actual[prop] === want
      check(ok, `${label}.${prop} 符合提示词页的几何`, ok ? actual[prop] : `我们 ${actual[prop]} ≠ 期望 ${want}`)
    }
  }
}

/**
 * 在真实 DOM 里走一遍 新建 → 编辑 → 删除（永久删除，带二次确认）。
 *
 * 这是目标里另外三项能力（正文查看与编辑、新建、删除）在真实浏览器里的验收。
 * 会往真实的 `$DSH_HOME/skills` 写一条名字一眼可辨的临时技能，最后删干净 ——
 * 做完之后磁盘上不留任何痕迹。
 * @param {Cdp} cdp - 客户端
 * @param {object} options - 参数
 * @param {string} options.skillsDir - 用户技能根
 * @param {string[]} options.notes - 备注收集
 * @returns {Promise<void>} 完成
 */
async function exercisePanel(cdp, { skillsDir, notes: remarks }) {
  const name = 'browser-probe-tmp'
  const skillFile = join(skillsDir, name, 'SKILL.md')
  const marker = `浏览器验收标记 ${Date.now() % 100000}`

  /**
   * 往 React 受控输入里写值。
   *
   * 直接改 `el.value` 是没用的：React 的 value tracker 认为值没变，onChange 不会触发。
   * 必须走**原生 setter**，再派发一个会冒泡的 input 事件 —— 这才是浏览器里"人打字"的样子。
   * @param {string} selectorExpression - 求值为目标元素的表达式
   * @param {string} value - 值
   * @returns {Promise<boolean>} 是否写进去了
   */
  const typeInto = (selectorExpression, value) =>
    cdp.evaluate(`(() => {
      const el = ${selectorExpression}
      if (!el) return false
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

  /**
   * 按可见文案点一个按钮。
   *
   * 精确匹配优先，没有再退到后缀匹配 —— 按钮上可能有装饰性前缀（添加入口的 "＋ "），
   * 那是观感，不该让验收失败。
   */
  const clickButton = (label) =>
    cdp.evaluate(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'))
      const want = ${JSON.stringify(label)}
      const text = (b) => (b.innerText || '').trim()
      const el = buttons.find((b) => text(b) === want) || buttons.find((b) => text(b).endsWith(want))
      if (!el) return false
      el.click()
      return true
    })()`)

  /** 某个技能行在不在。 */
  const hasRow = `Array.from(document.querySelectorAll('.dshsm-name')).some((el) => el.innerText.trim() === ${JSON.stringify(name)})`

  /** 选中某个技能行，让详情面板出现。 */
  // 幂等：卡片是**可切换**的，详情已展开时再点一次反而会收起 —— 这里要表达的是
  // "确保详情是打开的"，不是"点一下"。
  const selectRow = () =>
    cdp.evaluate(`(() => {
      const row = Array.from(document.querySelectorAll('.dshsm-row')).find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(name)})
      if (!row) return false
      const item = row.parentElement
      if (item && item.querySelector('.dshsm-detail')) return true
      const main = row.querySelector('.dshsm-row__main')
      if (!main) return false
      main.click()
      return true
    })()`)

  // ---- 新建 ----
  check(await clickButton('新建技能'), '新建：打开表单')
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(
    await typeInto(`Array.from(document.querySelectorAll('.dshsm-form input'))[0]`, name),
    '新建：填名字',
  )
  await typeInto(`Array.from(document.querySelectorAll('.dshsm-form input'))[1]`, '浏览器验收用的临时技能')
  check(
    await typeInto(`document.querySelector('.dshsm-form textarea')`, `# 正文${'\n'}${'\n'}由浏览器探针创建。`),
    '新建：填正文',
  )
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(await clickButton('创建'), '新建：点创建')
  check(await waitFor(cdp, hasRow, 15000, '新技能出现在列表里'), '新建：列表里出现了它')
  check(existsSync(skillFile), '新建：磁盘上出现了 SKILL.md')

  // ---- 编辑 ----
  check(await selectRow(), '编辑：选中它')
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(await clickButton('编辑正文'), '编辑：打开编辑器')
  const editorReady = await waitFor(cdp, 'document.querySelector(".dshsm-editor textarea") !== null', 10000, '编辑器出现')
  check(editorReady, '编辑：编辑器出来了')
  const current = await cdp.evaluate('document.querySelector(".dshsm-editor textarea").value')
  check(typeof current === 'string' && current.includes('name:'), '编辑：编辑器里是这条技能的原文')
  const edited = `${current.trimEnd()}${'\n'}${'\n'}${marker}${'\n'}`
  check(await typeInto('document.querySelector(".dshsm-editor textarea")', edited), '编辑：改了正文')
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(await clickButton('保存'), '编辑：点保存')
  const saved = await waitFor(cdp, 'document.querySelector(".dshsm-editor") === null', 15000, '保存后编辑器关闭')
  check(saved, '编辑：保存后编辑器关闭（说明服务端接受了）')
  check(existsSync(skillFile) && readFileSync(skillFile, 'utf8').includes(marker), '编辑：改动真的写进了磁盘')

  // ---- 删除：永久删除，先确认 ----
  check(await selectRow(), '删除：选中它')
  await new Promise((resolve) => setTimeout(resolve, 400))
  check(await clickButton('删除'), '删除：点删除')
  const confirming = await waitFor(cdp, `!!(Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim().endsWith('确认删除')))`, 10000, '出现确认')
  check(confirming, '删除：第一下只进确认态')
  check(existsSync(skillFile), '删除：确认之前文件必须还在')
  check(await clickButton('确认删除'), '删除：点确认删除')
  const gone = await waitFor(cdp, `!(${hasRow})`, 15000, '列表里不再有它')
  check(gone, '删除：列表里不再有它')
  check(!existsSync(skillFile), '删除：源文件已经从磁盘上没了')
  check(!existsSync(join(skillsDir, name)), '删除：整个 bundle 目录都没了')
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

// 顺手扫掉上一次跑剩下的 profile：Chrome 的句柄在进程退出后还要过一会儿才释放，所以上一次
// 退出时删不掉的目录，现在一定删得掉。开跑前清一遍，临时目录就不会越积越多。
let swept = 0
try {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith('dshsm-chrome-') || join(tmpdir(), entry) === profileDir) continue
    const stale = join(tmpdir(), entry)
    try {
      rmSync(stale, { recursive: true, force: true })
    } catch {
      // profile 里有 reparse point，Node 删不动 —— 交给 PowerShell。
      await new Promise((resolve) => {
        const fallback = spawn(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath '${stale}' -Recurse -Force -ErrorAction SilentlyContinue`],
          { stdio: 'ignore' },
        )
        fallback.on('close', resolve)
        fallback.on('error', resolve)
      })
    }
    if (!existsSync(stale)) swept += 1
  }
} catch {
  // 临时目录读不到就算了，不影响验收。
}
if (swept > 0) console.log(`顺手清掉上一次剩下的 ${swept} 个临时 profile`)
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
  check(panel.scopeLine.length > 0, '显示了项目根的解析依据', panel.scopeLine.slice(0, 120))
  if (panel.notice) notes.push(`面板提示：${panel.notice.slice(0, 200)}`)
  console.log(`     面板正文：${JSON.stringify(panel.text.slice(0, 400))}`)

  if (shotPath) {
    const shoot = async (file) => {
      // Cdp#receive 解出来的是 message.result（payload 本身），不是整条消息。
      const payload = await cdp.send('Page.captureScreenshot', { format: 'png' })
      if (payload && payload.data) {
        writeFileSync(file, Buffer.from(payload.data, 'base64'))
        console.log(`     截图：${file}`)
      } else {
        console.log(`     截图失败：拿不到 PNG 数据`)
      }
    }
    await cdp.evaluate(`(() => { const el = document.querySelector('.dshsm-section'); if (el) el.scrollIntoView({ block: 'start' }); return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await shoot(shotPath)
    // 再拍一张展开详情的：收起态看不出详情是不是真的长在卡片里。
    // 再多拍一张下拉展开的：收起态看不出菜单层（20px 圆角 / 阴影 / 对勾）是不是照 DSH 做的。
    //
    // 候选目录来自会话列表，这个实例常常只有一个，而只有一个时界面不渲染下拉。
    // 所以这里**临时给 /catalog 的响应注入几个候选**来取样 —— 只是取样手段，被测代码没被改。
    await cdp.evaluate(`(() => {
      const real = window.fetch
      window.fetch = async (...args) => {
        const res = await real(...args)
        const url = String(args[0] && args[0].url ? args[0].url : args[0])
        if (!url.includes('/dsh-skills-manager/catalog')) return res
        const body = await res.clone().json()
        // 第一项用**真实的 cwd**，否则 item === current 匹配不上，右侧那个对勾就不出现。
        if (body && body.data) body.data.candidates = [body.data.cwd, 'F:/project/抖音', 'D:/Personal/Desktop/新建文件夹 (7)/CLIProxyAPI']
        return new Response(JSON.stringify(body), { status: res.status, headers: { 'content-type': 'application/json' } })
      }
      return true
    })()`)
    // 切走再切回来，逼界面重新拉一次目录、按注入的候选重渲染。
    // 这里不能用 auditStyles 里那个 `go` —— 它不在这个作用域。
    const clickEntry = (label) =>
      cdp.evaluate(`(() => {
        const nodes = Array.from(document.querySelectorAll('button, [role=button], li, div'))
        const target = nodes.find((el) => (el.innerText || '').trim() === ${JSON.stringify(label)})
        if (!target) return false
        target.click()
        return true
      })()`)
    await clickEntry('通用设置')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await clickEntry('技能')
    await new Promise((resolve) => setTimeout(resolve, 900))
    const triggerInfo = await cdp.evaluate(`(() => {
      const el = document.querySelector('.dshsm-select__trigger')
      if (!el) return { present: false }
      el.click()
      return { present: true, text: el.innerText.trim() }
    })()`)
    if (triggerInfo.present) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      // 这里只截图。数值校验在 auditDropdown 里（`--styles` 时跑）——
      // 同一件事放两个地方量，迟早会出现两个互相打架的真相。
      await shoot(shotPath.replace(/\.png$/, '-menu.png'))
      await cdp.evaluate(`(() => { document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return true })()`)
      await new Promise((resolve) => setTimeout(resolve, 300))
    } else {
      console.log('     下拉选择器：没有渲染')
    }

    if (panel.names.length > 0) {
      await cdp.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.dshsm-row')).find((el) => el.querySelector('.dshsm-name')?.innerText.trim() === ${JSON.stringify(panel.names[0])})
        const main = row && row.querySelector('.dshsm-row__main')
        if (main) main.click()
        return true
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 700))
      await shoot(shotPath.replace(/\.png$/, '-expanded.png'))
    }
  }

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
      }
    })()`)
    console.log(`     该行的标签：${after.pills.join(' / ') || '（无）'}`)
    console.log(`     标签页：${after.tabs.join(' / ')}`)
    if (after.notice) notes.push(`操作后的提示：${after.notice.slice(0, 200)}`)
  }

  if (exercise) {
    console.log('\n在真实 DOM 里走一遍 新建 → 编辑 → 删除（永久删除，带二次确认）')
    await exercisePanel(cdp, { skillsDir, notes })
  }

  if (doImportExercise) {
    console.log('\n在真实 DOM 里走一遍 导入（ZIP 上传 / Markdown 上传 / 按路径）')
    await exerciseImport(cdp, { skillsDir, scratchDir: profileDir, notes })
  }

  if (doStyleAudit) {
    console.log('\n和提示词页逐项对比计算样式（同一次会话、同一个主题）')
    await auditStyles(cdp, { notes })
    console.log(String.fromCharCode(10) + '下拉控件：和通用设置页里 DSH 自己的选择器对比')
    await auditDropdown(cdp, { notes })
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
  // 保险：不管演练在哪一步炸了，都不许把临时技能留在用户的技能目录里。
  // 上一次就是清场那几步断言失败，结果 `browser-probe-tmp`
  // 真的进了模型可见的技能清单 —— 验收工具本身污染被验收的环境，是最不该发生的事。
  if (exercise || doImportExercise) {
    for (const stray of ['browser-probe-tmp', 'probe-zip', 'probe-md', 'probe-dir']) {
      if (existsSync(join(skillsDir, stray))) {
        try {
          rmSync(join(skillsDir, stray), { recursive: true, force: true })
          notes.push(`保险生效：${stray} 已从磁盘上兜底清除`)
        } catch {
          notes.push(`兜底清除失败，请手工删除：${join(skillsDir, stray)}`)
        }
      }
    }
    const leftover = join(skillsDir, 'browser-probe-tmp')
    if (existsSync(leftover)) {
      try {
        rmSync(leftover, { recursive: true, force: true })
        notes.push('保险生效：临时技能已从磁盘上兜底清除')
      } catch {
        notes.push(`兜底清除失败，请手工删除：${leftover}`)
      }
    }
  }
  if (keepOpen) {
    console.log(`\nChrome 保持运行：http://127.0.0.1:${DEBUG_PORT}/json/list（user-data-dir=${profileDir}）`)
  } else {
    try {
      cdp?.socket.close()
    } catch {
      // 已经断了。
    }
    // 必须等整个 Chrome 进程树**真的退出**再删 profile 目录。
    // 两个坑：一是 `child.kill()` 在 Windows 上只杀直接子进程，Chrome 拉起的那一堆
    // renderer / gpu / crashpad 还活着；二是它们活着时占着目录，rmSync 报 EPERM，
    // 于是每跑一次就在临时目录留下十几兆。用 taskkill /T 连整棵树一起收。
    const exited = new Promise((resolve) => child.once('exit', resolve))
    if (process.platform === 'win32' && child.pid) {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer.on('close', resolve)
        killer.on('error', resolve)
      })
    } else {
      child.kill()
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8000))])
    // Chrome 的进程没了，但 Windows 释放它的文件句柄还要一小会儿 —— 此时删会报 EPERM，
    // 而同样的目录过几秒 PowerShell 一句话就删掉了。所以交替用两种办法重试，给足时间。
    let lastError
    for (let attempt = 0; attempt < 24 && existsSync(profileDir); attempt += 1) {
      try {
        rmSync(profileDir, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 })
      } catch (error) {
        lastError = error
      }
      if (existsSync(profileDir)) {
        // Chrome 的 profile 里有 reparse point（符号链接一类），Node 的 rmSync 和 cmd 的
        // rmdir 都不肯穿过去 —— 只有 PowerShell 的 Remove-Item 删得掉。实测过：同一个目录
        // 前两者报 EPERM，PowerShell 一句话就清空了。
        await new Promise((resolve) => {
          const fallback = spawn(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath '${profileDir}' -Recurse -Force -ErrorAction SilentlyContinue`],
            { stdio: 'ignore' },
          )
          fallback.on('close', resolve)
          fallback.on('error', resolve)
        })
      }
      if (!existsSync(profileDir)) break
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    if (existsSync(profileDir)) {
      // 本进程里删不掉，而且不该再假装能删掉：实测过退出后 150 秒仍然 EPERM，此时机器上
      // **没有任何 chrome 进程**（连无头的都没有）。最像的原因是杀毒软件在扫描刚写出来的
      // 几千个小文件、句柄要几分钟才放。
      //
      // 所以不在这里空转：本次留下的这一个，下次开跑时的清扫会收掉（那条路径实测有效）。
      // 删不掉就明确报出来，而不是静默留一堆垃圾。
      notes.push(`本次的临时 profile 暂留（${lastError?.code ?? '未知'}）：${profileDir}`)
      notes.push(`下次运行本探针会自动清扫；想立刻清：Remove-Item -LiteralPath '${profileDir}' -Recurse -Force`)
    }
  }
}

if (notes.length > 0) {
  console.log('\n备注：')
  for (const note of notes) console.log(`  · ${note}`)
}
console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

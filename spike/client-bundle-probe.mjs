/**
 * 浏览器半边的真机验收：验证 `dsh web` **实际送出**的字节能不能注册出技能面板。
 *
 * 为什么需要这一层：前几轮都是用仓库里的源文件在自写的 mini React 运行时里测的。但从源文件
 * 到浏览器之间还有几步 —— 服务端要认出 `dsh.client.platform: web`、把它登记进模块表、给出
 * 带 `rev` 的 URL、再把文件送出去（可能还会追加 `sourceMappingURL`）。任何一步断了，用户
 * 重载后看到的就是一个空面板，而仓库里的测试**全都是绿的**。
 *
 * 所以这里取的是 `/plugins/??<包名>/client.js&rev=...` 那条 URL 的真实响应，把它放进同一个
 * 运行时里跑，并真的渲染一次。
 *
 * 前提：另有一个 web 实例在监听（不碰用户正在用的那个）：
 *   dsh web --port 3099 --no-open
 * 服务端启动日志里会打印带 token 的地址，本脚本自己去日志里取。
 *
 * 用法：node spike/client-bundle-probe.mjs [--base http://127.0.0.1:3099] [--log <启动日志>]
 */

import { readFileSync } from 'node:fs'
import { loadClient, makeFetch, textOf } from '../test/helpers/client-harness.mjs'

const PLUGIN_ID = '@lolkda/dsh-skills-manager'
const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(`--${flag}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const base = value('base', 'http://127.0.0.1:3099')
const logPath = value('log', '')

const failures = []

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
 * 换到会话 cookie：首页不接受裸请求，要先用启动日志里的 token 换。
 * @returns {Promise<string>} Cookie 头
 */
async function authenticate() {
  const candidates = [logPath, ...(process.env.DSH_PROBE_LOG ? [process.env.DSH_PROBE_LOG] : [])].filter(Boolean)
  for (const path of candidates) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    const token = /token=([A-Za-z0-9_-]+)/.exec(text)?.[1]
    if (!token) continue
    const response = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
    const cookie = (response.headers.getSetCookie?.() ?? []).map((item) => item.split(';')[0]).join('; ')
    if (cookie) return cookie
  }
  return ''
}

console.log(`目标实例：${base}`)

const cookie = await authenticate()
check(cookie.length > 0, '拿到会话 cookie', cookie ? `${cookie.split('=')[0]}=…` : '（没有可用的启动日志）')

const headers = cookie ? { cookie } : {}
const index = await fetch(`${base}/`, { headers })
check(index.status === 200, '首页可访问', `HTTP ${index.status}`)
const html = await index.text()

// 服务端给出的登记信息：id、带 rev 的 URL、以及从 manifest 读到的 inject。
const entry = new RegExp(`"id":"${PLUGIN_ID.replace(/[/@]/g, '\\$&')}","url":"([^"]+)"[^}]*`).exec(html)
check(entry !== null, '服务端把本插件登记进了客户端模块表')
if (!entry) {
  console.log('\n失败：插件根本没被登记，后面无从谈起。')
  process.exit(1)
}
const url = entry[1].replace(/&amp;/g, '&')
console.log(`     ${url}`)
check(url.includes('rev='), '登记的是带 rev 的 URL')

const inject = new RegExp(`"id":"${PLUGIN_ID.replace(/[/@]/g, '\\$&')}","url":"[^"]+","rev":"[^"]*","inject":\\[([^\\]]*)\\]`).exec(html)
check(inject !== null && inject[1].includes('dsh-client-ui-settings'), 'manifest 里的 client.inject 被正确读到', inject?.[1] ?? '（没读到）')

const served = await fetch(`${base}${url}`, { headers })
check(served.status === 200, '客户端 bundle 能取到', `HTTP ${served.status}`)
const source = await served.text()
check(source.includes('__ModuleLoader__'), '送出的确实是客户端 bundle')

console.log('\n把服务端送出的字节放进运行时')
const fetchStub = makeFetch({
  '/dsh-skills-manager/catalog': {
    ok: true,
    data: {
      cwd: 'F:/project/demo',
      candidates: ['F:/project/demo'],
      roots: [{ key: 'dsh', source: 'user-dsh', scope: 'user', rank: 400, path: 'C:/u/.dsh/skills', mutable: true, exists: true, skills: [] }],
      skills: [
        {
          name: 'demo-skill',
          description: '演示用技能',
          rootKey: 'dsh',
          source: 'user-dsh',
          docPath: 'C:/u/.dsh/skills/demo-skill/SKILL.md',
          winner: true,
          shadowed: false,
          loadable: true,
          enabled: true,
          diagnostics: [],
          invocation: { modelInvocable: true, userInvocable: true },
        },
      ],
      overrides: {},
      diagnostics: [],
      damaged: null,
      logPath: null,
    },
  },
  '/dsh-skills-manager/registry': {
    ok: true,
    data: { divergence: { checked: true, ours: 1, registry: 1, missing: [], extra: [], consistent: true } },
  },
})

const loaded = loadClient({ source, fetch: fetchStub, filename: 'served/client.js' })
check(loaded.module.name === 'dsh-skills-manager', '模块名正确', loaded.module.name)
check(Array.from(loaded.module.inject).join(',') === 'slots', 'inject 正确', Array.from(loaded.module.inject).join(','))
check(loaded.registered.length === 1, '注册了一个设置区块', `${loaded.registered.length} 个`)
check(loaded.registered[0]?.spec?.label?.() === '技能', '区块标签是「技能」')
check(loaded.styleTags.length === 1, '注入了一份样式')

const tree = await loaded.mount()
const text = textOf(tree)
check(text.includes('demo-skill'), '面板真的渲染出了技能名', text.slice(0, 80))
check(text.includes('已与 DSH 实际解析核对'), '渲染出了核对结论')
check(fetchStub.calls.some((call) => call.url.startsWith('/dsh-skills-manager/catalog')), '面板真的去调了后端接口')

console.log(`\n${failures.length === 0 ? '全部通过' : `失败 ${failures.length} 项：${failures.join('；')}`}`)
process.exit(failures.length === 0 ? 0 : 1)

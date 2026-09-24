/**
 * 发布计划：由 `package.json` 的版本号推出 git tag 与 npm dist-tag，并在真正发布前拦住两类事故。
 *
 * 为什么不把这段判断直接写在 workflow 的 bash 里：发布是不可逆动作，而这段判断有分支
 * （正式版 / 预发布版）、有拒绝路径（tag 与版本不一致、在分支上发布），bash 里写出来既
 * 测不到也审不动。抽成一个纯函数 + 一个薄 CLI，`test/release-plan.test.mjs` 就能在本地
 * 先把拒绝路径跑一遍，CI 里再跑一遍。
 *
 * 判定规则：
 * - 版本号含 `-`（如 `0.2.2-rc.1`）视为预发布 → dist-tag `next`；否则 → `latest`。
 *   预发布版绝不能落到 `latest`，否则所有 `npm install` 的用户都会拿到 rc 版。
 * - 传了 ref 就必须是 tag，且等于 `v<版本号>`；否则发布出来的产物版本与仓库标签对不上。
 *
 * 用法：
 *   node scripts/release-plan.mjs --version 0.2.2-rc.1 --ref refs/tags/v0.2.2-rc.1
 *
 * 输出：stdout 为 JSON（便于在 CI 日志里直接看）；若设置了 `GITHUB_OUTPUT`，同时追加
 * `version` / `tag` / `dist_tag` / `prerelease` 四行，供 workflow 用 `steps.*.outputs` 消费。
 */

import { appendFileSync } from 'node:fs'
import process from 'node:process'

/** 目标 registry；写死是为了不让 `--registry` 之类的环境变量把发布引到别的仓库。 */
const REGISTRY = 'https://registry.npmjs.org'

/** 语义化版本号；不接受 `v` 前缀，也不接受两段式版本。 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/**
 * 由版本号与 git ref 算出发布计划。
 *
 * @param {{ version?: string, ref?: string }} input - `version` 取自 package.json；`ref` 是 CI 给的 ref，本地手跑可省略
 * @returns {{ ok: true, plan: { version: string, tag: string, distTag: string, prerelease: boolean, registry: string } }
 *   | { ok: false, error: string }} 计划或人类可读的拒绝原因
 */
export function planRelease({ version, ref } = {}) {
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    return {
      ok: false,
      error: `版本号不合法：${JSON.stringify(version ?? null)}，期望形如 0.2.2 或 0.2.2-rc.1（不带 v 前缀）`,
    }
  }

  const prerelease = version.includes('-')
  const tag = `v${version}`

  if (typeof ref === 'string' && ref !== '') {
    if (!ref.startsWith('refs/tags/')) {
      return {
        ok: false,
        error: `只在 tag 上发布：当前 ref 是 ${ref}，期望 refs/tags/${tag}`,
      }
    }
    const refTag = ref.slice('refs/tags/'.length)
    if (refTag !== tag) {
      return {
        ok: false,
        error: `tag 与 package.json 版本不一致：tag 是 ${refTag}，package.json 是 ${version}（期望 tag ${tag}）`,
      }
    }
  }

  return {
    ok: true,
    plan: { version, tag, distTag: prerelease ? 'next' : 'latest', prerelease, registry: REGISTRY },
  }
}

/**
 * 读一个 `--flag value` 形式的参数。
 *
 * @param {string[]} argv - 命令行参数
 * @param {string} flag - 参数名
 * @returns {string|undefined} 参数值
 */
function readFlag(argv, flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

/**
 * CLI 入口：算计划、打印 JSON、写 GITHUB_OUTPUT，失败时以非零码退出。
 *
 * @returns {number} 进程退出码
 */
function main() {
  const argv = process.argv.slice(2)
  const result = planRelease({
    version: readFlag(argv, '--version'),
    ref: readFlag(argv, '--ref') ?? process.env.GITHUB_REF_NAME_REF,
  })

  // stdout 打扁平结构（而不是 `{ok, plan}`），这样 workflow 里可以直接 `jq -r .distTag` 排错。
  const printable = result.ok ? { ok: true, ...result.plan } : result
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)

  if (!result.ok) {
    process.stderr.write(`发布计划被拒绝：${result.error}\n`)
    return 1
  }

  const output = process.env.GITHUB_OUTPUT
  if (output) {
    const { version, tag, distTag, prerelease } = result.plan
    appendFileSync(output, `version=${version}\ntag=${tag}\ndist_tag=${distTag}\nprerelease=${prerelease}\n`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main()
}
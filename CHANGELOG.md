# Changelog

## Unreleased

### Changed

- 运行时清单解除 DSH 版本门禁：`@deepseek-ai/dsh-client-connection` 与 `@deepseek-ai/dsh-skill` 的 peer 范围改为 `*`，`dsh.compatibility.dsh` 同步改为 `*`。安装不再仅因宿主版本号被拒绝；`0.2.1-alpha.2` 仍是当前验收基线，未来版本需重新做真实宿主回归。

## 0.3.0 (2026-10-11)

**Breaking**：HTTP 端点改走官方 `/api` 通道的精确 Fetch 路由表（`ctx.connection.fetch.register`），不再自己往 `webServer` 上挂 `/dsh-skills-manager` 前缀路由。

### Fixed

- Settings 面板在 DSH 0.2.x 上全程报「接口返回了非 JSON 响应（HTTP 404）」，整个界面不可用。根因：DSH 0.2.0 删除了 `webRuntime` 服务，而本插件把「等 Web 就绪」的条件写成 `['webServer', 'webRuntime']`，闸门永远不满足 —— 宿主半边挂载正常（工具、技能覆盖都工作），只有 HTTP 端点从未注册，每个请求都落到 404。见 [决策笔记](https://github.com/lolkda/dsh-skills-manager/blob/master/.agents/notes/implemented/architecture/2026-10-11-official-api-fetch-routes.md)。
- 顺带修掉同一改动会立刻暴露的第二个故障：受信主机列表同样来自 `webRuntime.trustedHosts`，即使端点注册成功，从 LAN 地址（如 `http://192.168.1.100:3080`）访问也会被插件自己的 Host 校验判 403。

### Changed

- **访问控制移交宿主**：端点注册在官方 `/api` 通道下，宿主的 `/api` 前缀处理器在调用我们之前完成 Host/Origin fence 与浏览器会话鉴权。插件不再自带 Host 校验（原 `validateHost` 已删除），未认证请求得到宿主的标准 401/403 —— 比旧行为多了一层浏览器会话鉴权。
- 端点前缀由 `/dsh-skills-manager` 变为 `/api/dsh-skills-manager`，共 8 条精确路由（`catalog`、`registry`、`skill/content`、`policy`、`skill/create`、`skill/save`、`skill/delete`、`skill/import`）。读端点只登记 GET，写端点只登记 POST；方法不匹配时由宿主通道直接回 404，插件不再自己产生 405。
- 请求体改为 Fetch 语义读取；上限仍是本插件自己的 48 MiB（ZIP 以 base64 传输），超过返回 413；非法 JSON 现在明确返回 400 `body.invalid`（以前会落进 500）。
- 客户端把宿主的 401/403 翻成人能看懂的话，不再笼统报「非 JSON 响应」。

### Compatibility

- 需要 **DSH >= 0.2.1-alpha.2**（官方 Fetch 注册表与新版 connection fence 所在版本）。0.1.x 与 0.2.0 不再支持：旧版本的 `/api` 通道没有精确 Fetch 路由表。
- `dsh.compatibility.dsh` 更新为 `>=0.2.1-alpha.2 <0.3.0`，并新增 `@deepseek-ai/dsh-client-connection` peer 依赖（同样只在 `>=0.2.1-alpha.2 <0.3.0` 上验证）。

## 0.2.2 (2026-09-24)

第一个经 GitHub Actions 发布的版本。`0.2.1` 与 `0.2.2-rc.1` 只存在于本仓库的提交里，从未发到 npm；`0.2.2` 把它们的内容一起带上。

### Added

- GitHub Actions release pipeline: pushing a `v<version>` tag (or a manual dispatch with a dry-run option) runs the test suite, packs the tarball, and publishes it to npm. Stable versions go to `latest`, versions containing `-` go to `next`, so a prerelease can never take over `latest`.
- Authentication uses npm Trusted Publishing (OIDC): no long-lived npm token and no repository secret. The publish job holds `id-token: write`, npm (>= 11.5.1) exchanges the GitHub id_token for a package-scoped short-lived token, and the same id_token signs the provenance attestation.
- A preflight step fails fast when the OIDC prerequisites are missing (npm older than 11.5.1, or no `id-token: write`), and the dry-run mode asserts that credentials were actually available — a bare `npm publish --dry-run` exits 0 even with no credentials at all, which makes it useless as a rehearsal.
- `scripts/release-plan.mjs` derives the git tag and dist-tag from `package.json` and refuses to publish when the tag does not match the version or when the ref is not a tag. Covered by `test/release-plan.test.mjs`.
- `ci.yml` runs the same `npm run check` on branches and pull requests, on Node 24 and Node 22 (`engines` lower bound).

### Fixed

- Add the missing `@deepseek-ai/dsh-tools` dev dependency. `test/tools.test.mjs` imports it for the JSON Schema subset assertions, so without it that file failed at import and the suite could not be green on a clean checkout: 189 passing / 1 failing before, 196 passing / 0 failing after.

### Notes

- Release procedure, the one-time Trusted Publisher registration on npmjs.com, and the pitfalls found while testing this locally: [docs/release.md](https://github.com/lolkda/dsh-skills-manager/blob/master/docs/release.md). No step requires running `npm publish` locally or storing an npm token.

## 0.2.1

### Fixed

- Bind skill registry checks to the GUI's selected session instead of the first agent with the same working directory. Skills added directly to DSH's skill directories are no longer falsely reported as missing because an older session has an empty registry.
- Send the current session ID and working directory through the settings panel's catalog and registry requests.
- Clear session-specific UI state and discard delayed responses after switching sessions, including switches within the same directory.
- Reject registry responses for another session, including responses from older backends that ignore the session ID.
- Leave checks inconclusive when the requested session is unavailable or the directory has multiple candidates and no session ID was supplied. Explicitly selected empty sessions still report genuine differences.

### Tests

- Add 15 regression cases using real DSH registries, filesystem providers, temporary skill directories, and client-to-route requests.
- Targeted suite: 67 passing tests.
- Full suite on Linux / Node 24.21.0 / DSH 0.1.6-alpha.2: 179 passing, 5 pre-existing failures. These are one attachment file-to-directory overwrite failure and four Windows-specific path assertions; see the [verification report](https://github.com/lolkda/dsh-skills-manager/blob/master/docs/session-registry-fix.md#全量验证).

### Upgrade

- No skill content, invocation policy, or saved override is migrated or rewritten.
- Replacing an installed plugin requires restarting the DSH host; a browser refresh alone does not replace its loaded ESM backend.

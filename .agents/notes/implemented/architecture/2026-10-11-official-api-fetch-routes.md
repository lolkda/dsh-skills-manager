# Agent Note: 端点改走官方 /api 精确 Fetch 路由表

Status: implemented

## Problem

DSH 0.2.0 起删掉了 `webRuntime` 服务，而本插件的 HTTP 半边把「等 Web 就绪」写成
`['webServer', 'webRuntime']`：闸门永远不满足，延迟注入的回调永不执行，8 个端点从未注册。
宿主半边其余部分（技能覆盖、Agent 工具、每个 agent 作用域的注册）一切正常，日志里只有一行
`install-deferred`，「每个请求都 404」这件事没有任何别的痕迹 —— 设置页因此全程报
「接口返回了非 JSON 响应（HTTP 404）」，整个技能面板不可用。

同一处还会立刻暴露第二个故障：受信主机列表也来自 `webRuntime.trustedHosts`，一旦端点能注册，
从 LAN 地址（`http://192.168.1.100:3080` 这类非回环 Host）访问又会被插件自己的 `validateHost`
判 403 —— 权威的受信列表已经搬到 `dsh-client-connection` 的 config 里，插件再抄一份就是第二个
真相源。

不做的后果：面板在 0.2.x 上完全不可用；而只把服务名改成 `webServer` 能救 404，救不了 403，
也救不了「自有前缀路由没有任何会话鉴权」这个更根本的问题。

## Decision

端点注册进官方 `/api` 通道的**精确 Fetch 路由表**：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`。
是本插件唯一的暴露面，不再往 `webServer` 直注册任何路由。

- 前缀 `/api/dsh-skills-manager`，8 条精确路径，每条只声明自己真正使用的方法：
  `catalog` / `registry` / `skill/content` 为 `GET`，`policy` / `skill/create` / `skill/save` /
  `skill/delete` / `skill/import` 为 `POST`，`requestBody` 一律 `buffered`。
- **访问控制整体移交宿主**：`/api` 前缀处理器在调用我们的 handler 之前完成 Host/Origin fence
  （回环、`connection.trustedHosts`、监听地址本身）与浏览器会话鉴权（cookie `dsh-auth-<authority 哈希>`，
  `Path=/; HttpOnly; SameSite=Strict`）。未通过的请求到不了 handler，本插件删除 `validateHost`，
  不再产生 401/403。
- **方法过滤也由宿主完成**：方法不在声明里就不会被分发（宿主回纯文本 404），因此 handler 里
  没有任何方法判断分支，也没有 405。
- 业务失败语义保持不变：HTTP 200 + `{ ok: false, code, error }`；请求体不是合法 JSON 明确回
  400 `body.invalid`（旧实现会落进 500），超过 48 MiB 回 413 `body.tooLarge`，其余异常回 500 `internal`。
- 就绪闸门改为 `['webServer', 'connection']`：`connection` 提供注册表，而它自己要在 `webServer`
  出现后才把 `/api` 挂到 HTTP 服务上，两者缺一，注册进去的端点都没人来敲。拿不到
  `connection.fetch.register` 时 `installRoutes` 直接抛错 —— 宁可没有端点，也不退回自己挂一条
  不受宿主鉴权的通道。
- 浏览器半边 base 改为 `/api/dsh-skills-manager`，并把宿主的 401/403（纯文本响应体）翻成可读提示，
  不再把「没有会话」说成「非 JSON 响应」。
- 兼容性收窄：需要 **DSH >= 0.2.1-alpha.2**。`dsh.compatibility.dsh` 与新增的
  `@deepseek-ai/dsh-client-connection` peer 都声明 `>=0.2.1-alpha.2 <0.3.0`。

## Alternatives considered

- **只改就绪条件为 `['webServer']`，保留自有 `/dsh-skills-manager` 前缀路由** — 最强理由是改动最小、
  两个版本都能跑，而且暴露面完全由插件自己掌握。否决：修好 404 后从 LAN 访问立刻 403，因为受信
  列表已经没有可读的权威来源；要么自己复刻一份 fence（跟着宿主升级漂移的第二个真相源），要么去读
  没有公开承诺的 `connection.trustedHosts` 字段。更关键的是，自有前缀路由**完全没有会话鉴权**——
  任何能连到端口的人都能改磁盘上的技能，比官方通道弱一档。
- **保留前缀路由，只把 fence 换成 `ctx.connection.requestRejection(req)`** — 最强理由：复用官方
  fence、只动几行，而且 `requestRejection` 在 0.1.5+ 就存在（`dsh-meow-smooth` 的 `auth-gate.ts`
  正是这么做的），跨版本性最好。否决：仍然自己挂前缀路由，仍然要自己维护 401/403 的语义与错误体，
  而「谁有权访问这个端点」本就该由承载通道决定；官方注册表已经把这件事做完，没有理由再抄一遍。
- **改走官方 RPC 通道（`ctx.connection.rpc.handle('/rpc')` + Remote 方法）** — 最强理由：与 DSH
  自己的 API 完全同构，客户端可以直接用生成的 remote 调用，最不容易随宿主演进漂移。否决：本插件的
  浏览器半边是手写懒 CJS 工厂、刻意不引入打包器，接入 Remote 意味着引入 typert 的客户端运行时与
  schema 生成；而端点里还有 ZIP 上传这类非 JSON 负载，本来也不适合 RPC 形态。

## Consequences

- **收益**：面板在 DSH 0.2.x 上恢复可用；暴露面收窄成一条宿主管理的通道，鉴权强度从「只有一份自己
  写的 Host 校验」提升到「宿主的 fence + 浏览器会话鉴权」；插件里少了一整块安全判定代码。
- **代价与已知上限**：丢掉 0.1.x 与 0.2.0 兼容（那些版本没有精确 Fetch 路由表）；端点路径从
  `/dsh-skills-manager` 变成 `/api/dsh-skills-manager`，外部脚本、书签、文档里的 curl 都要跟着改；
  插件不再能独立决定「谁能访问自己的端点」，宿主 fence 语义变化会直接改变可用性（例如非回环 Host
  必须出现在 `connection.trustedHosts` 里，或等于监听地址本身）；宿主的请求体上限（默认 300 MiB）
  先于本插件的 48 MiB 生效，超大上传会在宿主层被拒而不是在这里。
- **何时必须重访**：宿主再次改动 `/api` 注册表接口或 fence 语义；或出现「在非 Web profile 里也要
  暴露这些端点」的需求（那时得重新考虑第二通道，而不是把前缀路由加回来）。

## Verification

- `npm run check`：196 通过 / 0 失败。
- `test/plugin.test.mjs` 断言 8 条精确路由、每条的方法与 `requestBody`、以及 **`webServer` 上没有任何
  直注册路由**；延迟就绪用例断言「只有 webServer 时不注册、`connection` 出现后才注册」。
- `test/helpers/host-harness.mjs` 复刻宿主的分发规则（未声明的方法直接 404），避免测试误以为
  方法用错也能进 handler。
- `audit/regressions.mjs` 的 R01 断言全部端点在 `/api` 之下，且缺少官方注册表时 `installRoutes` 直接抛错。
- 真机（DSH 0.2.1-alpha.2，隔离 profile 副本，`dsh web --port 3099 --host 127.0.0.1 --no-open`）：
  未带会话 cookie 的 `curl /api/dsh-skills-manager/catalog` → 401；走 `/go` 拿到 cookie 后
  `catalog` / `registry` → 200 JSON；`POST /api/dsh-skills-manager/catalog` 与旧前缀
  `/dsh-skills-manager/catalog` → 404；宿主实际下发的客户端 bundle 里 `ROUTE` 已是
  `/api/dsh-skills-manager`。同一台上用旧版 0.2.2 复现了原故障（旧前缀 404，日志只有
  `install-deferred ... webRuntime 尚未就绪`）。完整记录见 `audit/runtime-verify-0.3.0.log`。
- 未覆盖：浏览器里的真实渲染。本沙箱内没有可用的浏览器（chrome-devtools MCP 无 Chrome 可连），
  面板的视觉与交互只由 `test/client-render.test.mjs` 的迷你渲染器覆盖数据流，不代表真实 DOM 的结果。

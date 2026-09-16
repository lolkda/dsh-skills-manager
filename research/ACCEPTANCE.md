# 真机验收记录

环境：Windows 10.0.19045，DSH `0.1.5-rc.1`，profile `web`，验证实例 `dsh web --port 3099 --no-open`
（**没有触碰**用户正在使用的 3080 实例）。

## 1. 安装

```
dsh plugin --profile web add link:F:/project/dsh-skills-manager
→ + @lolkda/dsh-skills-manager link:F:/project/dsh-skills-manager
```

`dsh --profile web --dump-config` 确认两行并存：

```
# == @michengai/dsh-skills-manager
- id: skills-manager
  name: '@michengai/dsh-skills-manager'
# == @lolkda/dsh-skills-manager
- id: dsh-skills-manager
  name: '@lolkda/dsh-skills-manager'
```

## 2. 启动期抓到的两个真问题（已修）

| 现象 | 根因 | 修法 |
|---|---|---|
| **整个 profile 插件树加载失败、DSH 无法启动** | `ctx.tools.register` 要求 `output { schema, render }`，缺 `render` 直接抛错 | 补 `render`，并让 `test/plugin.test.mjs` 断言每个工具的 `output` 完整 |
| 路由全部 404，服务端日志一片干净 | `inject` 只声明了 `['skills']`，cordis 于是在 `webServer` 就绪**之前**就挂载本插件，`ctx.get('webServer')` 得到 `undefined`，路由静默跳过 | `inject` 改为与 michengai 一致的五个服务；无论成功还是跳过都写一条诊断日志 |

附带发现：`/api` 前缀被 `dsh-client-connection` 注册的**鉴权路由**占据，而前缀路由先注册先匹配；本插件的 bundle 排在 profile 末尾，因此所有 `/api/*` 请求恒定 401。`@lolkda/dsh-prompt-manager` 早已用非 `/api` 前缀绕开这一点 —— 本插件照做，路由落在 `/dsh-skills-manager`。

## 3. 运行时证据

挂载日志（本插件自己的活动日志）：

```
{"ts":"...","event":"routes-mounted","detail":"HTTP 路由已注册到 /dsh-skills-manager"}
```

停用前，注册表（真实 `ctx.skills.snapshot()`）：

```
test-driven-development    model=true   user=true   provider=dsh-skills-manager-external
```

执行 `POST /dsh-skills-manager/policy {"rootKey":"dsh","name":"test-driven-development","enabled":false}`：

```
test-driven-development    model=false  user=false  provider=dsh-skills-manager   fromThisPlugin=true
```

源文件零改动：`grep -c disable-model-invocation ~/.dsh/skills/test-driven-development/SKILL.md` → `0`。

清除覆盖（`enabled: null`）后回到 `model=true provider=dsh-skills-manager-external`，`state.json` 为 `{"version":1,"overrides":{}}` —— **完全可逆**。

浏览器半边：`GET /?token=…`（令牌交换 → 持久化 cookie）返回的引导页面里，模块清单包含

```
@lolkda/dsh-prompt-manager/client.js,@michengai/dsh-skills-manager/client.js,@lolkda/dsh-skills-manager/client.js
```

即客户端 bundle 已被模块系统收录。

## 4. 会话级证据：宿主层不是会话层

移除 michengai 之后 `/registry` 返回 `count=0`，起初像是故障。查 `dsh-skill` 源码后确认是**预期**：`collectFresh` 的候选来自 `[layers.global, ...chainLayers(scope)]`，不带 `scope` 只读 global；真实技能由 preset 层提供（`dsh-base` 那几行管线的落点不在 global），所以宿主层在真实部署里本来就是空的。

这解释了为什么必须双重注册，也解释了为什么早先那次 401 之外的第一次验收「通过」得有点容易 —— 那次读的是宿主层，而宿主层当时只有我们和 michengai 两家在供数。

因此 `/registry` 改为：有 agent 时报告 agent 层的合并结果并标注 `scope: "agent"`，没有 agent 时退回宿主层并标注 `scope: "host"`，同时始终附上 `host` 视图供对照。这样它才是一个不会误导人的自证端点。

## 5. michengai 的取舍（已按用户选择执行）

用户选择「先导入到 `$DSH_HOME/skills`，再移除 michengai」。执行结果：

```
node scripts/migrate-external-skills.mjs
→ 导入 4 条，跳过 0 条，失败 0 条

$DSH_HOME/skills: apple-liquid-glass  frontend-ui-system  grill-me  grilling
                  improve-codebase-architecture  python-typed-development-standards
                  reverse-flow  test-driven-development
```

`apple-design-skill-project` 按 frontmatter 的 `name` 落成 `apple-liquid-glass`（64 个附属文件原样保留）。三个外部副本（cc-switch / codex / claude）逐字节一致，脚本用 `~/.cc-switch/skills` 作源。

`dsh plugin --profile web remove @michengai/dsh-skills-manager` 之后，本插件自己的目录视图：

```
/catalog 根        = dsh(8)  agents(1)
/catalog 生效技能  = apple-liquid-glass, frontend-ui-system, grill-me, grilling,
                     improve-codebase-architecture, python-typed-development-standards,
                     refactor, reverse-flow, test-driven-development
/registry          = scope: host, host skills: 0, agents: []
```

9 条技能全部可见，`grilling`（原先被 michengai 挤出裁决）回来了，4 条外部技能已变成 DSH 自有技能。michengai 自己的状态已备份到 `research/backup-michengai/state.json`。

## 6. 读与写的作用域不对称（本轮最重要的发现）

`dsh-skill` 里有一处不对称，几乎必然踩一次：

| 方向 | 作用域从哪来 |
|---|---|
| **写** `registerProvider` | 从调用上下文推断：`scopeOf(this.ctx)` |
| **读** `snapshot` / `get` | **只**看 `options.scope`，不从上下文推断 |

所以「从 agent 的 ctx 上调 `snapshot({})`」看起来完全合理，实际读到的是 `global` 层 —— 而真实部署里 global 层**一条技能都没有**（技能由 preset 层提供）。这个错误的表现是「界面显示正常、注册表查询为空」，极容易被误判成"没有技能"。

本轮之前 `/registry` 正是这样：它读宿主层，于是移除 michengai 后返回 `count=0`。现在它按每个 agent 的**显式作用域**读取，并如实标注 `scope` 与无法解析时的原因。

另外，作用域符号是上游**模块私有**的（`Symbol("dsh.scope")`，不是 `Symbol.for`）。从本包 `import` 那个包再 `scopeOf(ctx)`，在 profile 里可能落到另一个模块实例上、返回 `undefined`。`lib/scope.js` 因此改为按符号描述从上下文对象上直接取，跨实例安全，也不给本插件增加对内部包的直接依赖。

## 7. 核心能力不再依赖 Web 半边（设计修正）

第一次的 `inject` 写成了 `['webServer','webRuntime','skills','tools','sessions']`。那样虽然修好了「路由静默不注册」，却让整个插件在**缺 Web 服务的 profile**（headless、SDK）里根本不挂载 —— 而技能覆盖是这个插件的核心能力，不该被界面绑死。

现在改为 `inject: ['skills']` + cordis 的「就绪后再装」惯用法：

```js
const ready = services.every((s) => ctx.get?.(s) !== undefined)
if (ready) ctx.effect(() => install(ctx))
else ctx.inject(services, (inner) => ctx.effect(() => install(inner)))
```

真机日志里能看到这两步都发生过：

```
{"event":"install-deferred","detail":"HTTP 路由：webServer、webRuntime 尚未就绪，等它出现再注册"}
{"event":"routes-mounted","detail":"HTTP 路由已注册到 /dsh-skills-manager"}
```

`test/plugin.test.mjs` 有一条专门的回归测试覆盖这个时序。

## 8. agent 级端到端证据（`test/agent-scope.test.mjs`）

这是在不启动真实会话的前提下能做到的最强验证，也是本轮补上的关键一环。它走**插件自己的 `apply()`**，用真实 cordis + 真实 `dsh-scope` + 真实 `dsh-skill` + 真实 `dsh-skill-filesystem`：

1. preset 层挂在一个 scope 上（正如 `standard` preset 所做）；
2. `apply()` 挂载插件；
3. 触发 `agent/created`，让插件按真实代码路径为这个 agent 注册覆盖提供方；
4. 用插件真实的策略接口停用一条技能；
5. 断言**该 agent 所在层**解析出的结果翻转，且源文件零改动。

```
✔ 未设覆盖时，agent 层看到 preset 层文件系统提供的全部技能
✔ 停用后，该 agent 作用域里的裁决真的翻转（不碰源文件）
```

它同时验证了 `lib/scope.js` 自行解析出的作用域 key 与上游 `scopeOf()` 一致。

## 9. 会话级观测：走过三条死路，第四条通了

「停用后**活动会话**的技能目录里不再列出它」这一项要求一个真实 agent 会话。试过的四条路：

| 路径 | 结果 |
|---|---|
| `sdk-minimal` profile 跑一次性任务 | 该 profile **刻意排除 skills**，插件不会挂载 |
| web app 一次性 prompt | `dsh --profile web` 没有这个选项 |
| 直接调 `/api` RPC 建会话 | 端点由 typert 生成，未在合理成本内定位 |
| **`dsh-base` + `dsh-sdk-app` 自建 headless profile** | **成功**，见第 12 节 |

## 10. 最终代码的真机复验

改完延迟注入与 scope 读法之后，用 `dsh web --port 3099 --no-open` 重新引导，跑完整流程：

```
GET  /dsh-skills-manager/catalog                → 200
GET  /dsh-skills-manager/registry               → scope=host  host.skills=0  agents=[]
POST /dsh-skills-manager/policy  grilling=false → ok=true changed=true
     registry: provider=dsh-skills-manager model=false user=false
POST /dsh-skills-manager/policy  grilling=null  → ok=true changed=true
     registry: （回到基线）
```

三个细节值得记下：

1. **基线里 `grilling` 根本不在宿主层** —— 因为技能由 preset 层提供，宿主层本来就是空的。停用之后它以我们的候选身份出现，清除之后又消失。这从反面说明「读宿主层」这种验证方式本身有多容易误判。
2. 源文件 `~/.dsh/skills/grilling/SKILL.md` 里 `disable-model-invocation` 出现 **0** 次 —— 全程未改文件。
3. 收尾时 `state.json` 回到 `{"version":1,"overrides":{}}`，全部覆盖已清除，不留残留。

活动日志同时记下了两个半边都装上了：

```
{"event":"install-deferred","detail":"HTTP 路由：webServer、webRuntime 尚未就绪，等它出现再注册"}
{"event":"routes-mounted","detail":"HTTP 路由已注册到 /dsh-skills-manager"}
```

## 11. 测试现状

```
node --test  →  82 tests, 82 pass, 0 fail
```

| 文件 | 覆盖 |
|---|---|
| `frontmatter.test.mjs` | frontmatter 解析、布尔极性、非法写法、**与 DSH 解析器的一致性** |
| `roots.test.mjs` | 根目录发现与 rank |
| `catalog.test.mjs` | 聚合、遮蔽、覆盖生效、**仲裁只在可加载候选之间** |
| `registry.test.mjs` | 对**真实** `dsh-skill` + `dsh-skill-filesystem` 的集成 |
| `layers.test.mjs` | 分层遮蔽：同层 rank 0 胜出、跨层必败 |
| `agent-scope.test.mjs` | 走真实 `apply()` 的 agent 级端到端翻转 |
| `plugin.test.mjs` | 插件级 HTTP 路由与工具注册、延迟注入时序、scope 传递 |
| `client.test.mjs` | 浏览器半边契约（注册形状、模块依赖、样式注入） |
| `client-render.test.mjs` | 浏览器半边数据流（挂载拉取、渲染、切换请求、错误显示、不可加载项） |
| `zip.test.mjs` / `operations.test.mjs` | ZIP 与 zip-slip、新建/编辑/导入/回收站 |

## 12. 会话级证据：headless profile 里的真实 agent

这是目标里明确要求的那一项，也是唯一一项不能靠推断交差的。

`@deepseek-ai/dsh-sdk-app` 的 patch 注释写明它是 **"over dsh-base"**，而 `dsh-base` 正好挂载
`skill`(273) / `skill-filesystem`(276) / `tool-skill`(283)。于是 `dsh-base + dsh-sdk-app`
就是一个**带 skills 的 headless agent**：

```
~/.dsh/profiles/skillprobe/package.json
  dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-sdk-app"]
```

这一层还有个便宜可占：`dsh-sdk-jsonrpc-server` 的 initialize 里写着

```js
if (!this.hasAdapterFor(provider)) {
  if (provider !== "deepseek-official") throw new Error(`no adapter registered for provider "${provider}"`);
  this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {});
}
```

所以只要 `provider` 传 `deepseek-official`，适配器由服务器自己挂上 —— 既不用装适配器包，也
**不需要可用的 API key**：会话建立（以及随之而来的 `agent/created`）发生在模型调用之前。

驱动脚本 `spike/session-probe.mjs` 说换行分隔的 JSON-RPC：`initialize` → `session/prompt`
（未知 `sessionId` 会**懒创建 agent+session 对**）→ `shutdown`。
配套的 `spike/policy-set.mjs` 调用插件真实的 `createRuntime()` + `setEnabled()` 改启停 ——
不是手写 `state.json`，那样验证的就不是插件本身了。

### 三次会话的对照

| 会话 | 操作 | `scope-snapshot` 里的 grilling |
|---|---|---|
| A | 基线 | `grilling`（可用） |
| B | 停用 grilling | `grilling（模型不可用）` |
| C | 清除覆盖 | `grilling`（可用） |

原始日志（`~/.dsh/dsh-skills-manager/dsh-skills-manager.log`）：

```
{"ts":"2026-09-15T22:21:24.287Z","event":"scope-snapshot","detail":"agent session-probe-1789510880047 的技能视图：共 8 条 —— frontend-ui-system、grill-me（模型不可用）、grilling、improve-codebase-architecture（模型不可用）、python-typed-development-standards、refactor、reverse-flow、test-driven-development"}
{"ts":"2026-09-15T22:22:00.263Z","event":"scope-snapshot","detail":"agent session-probe-1789510916006 的技能视图：共 8 条 —— frontend-ui-system、grill-me（模型不可用）、grilling（模型不可用）、improve-codebase-architecture（模型不可用）、python-typed-development-standards、refactor、reverse-flow、test-driven-development"}
{"ts":"2026-09-15T22:22:21.321Z","event":"scope-snapshot","detail":"agent session-probe-1789510937074 的技能视图：共 8 条 —— frontend-ui-system、grill-me（模型不可用）、grilling、improve-codebase-architecture（模型不可用）、python-typed-development-standards、refactor、reverse-flow、test-driven-development"}
```

证据来自**新建会话自己解析出的技能目录**，不是插件的状态接口，也不是自称。
全程源文件 `~/.dsh/skills/grilling/SKILL.md` 里 `disable-model-invocation` 出现 **0** 次；
收尾 `state.json` 为空。

## 13. 由此暴露并修掉的一处诚实性 bug

对账时发现：磁盘上 9 条候选，会话视图只有 8 条 —— `apple-liquid-glass` 缺席。

原因是它的 `description` 是一段未加引号的长文本，里面有 `macOS): light grey-white ground`。
冒号后跟空格在 YAML 里意味着嵌套映射，DSH 用的 `yaml` 库因此报
`Nested mappings are not allowed in compact mappings`，**整条技能被丢弃**。
（用 DSH 同款解析器直接验证过。）

而本插件当时报的是 `loadable: true, winner: true, diagnostics: []` ——
界面会说它生效，模型却从来没见过它。**这比不做还糟：它让用户以为自己被保护了。**

两处根因，两处修复：

1. `lib/frontmatter.js`
   - 未加引号的值里出现 `: `（或以 YAML 指示符开头）→ error 诊断，并给出"把整个值用引号包起来"的修法；
   - 解析不了的行从 `warn` 升级为 `error` —— DSH 遇到任何 YAML 失败都是整条丢弃，这里报轻了就等于骗人；
   - `loadable` 的判据改为「没有任何 error 级诊断」。它曾经只检查几个具名字段，于是会出现
     "解析失败但仍然 loadable=true"。
2. `lib/catalog.js`
   - 仲裁只在**可加载**的候选之间进行。DSH 看不到坏记录，所以它既不能胜出，也不能把后面
     真正会被加载的那条挤成"被遮蔽"；同名技能全部不可加载时，这个名字就没有胜出者。

修完后逐条吻合：

```
我们的生效集合 (8): frontend-ui-system, grill-me, grilling, improve-codebase-architecture,
                    python-typed-development-standards, refactor, reverse-flow, test-driven-development
DSH 会话视图 (8):   同上（逐条一致）
apple-liquid-glass: loadable=false
```

界面本来就在详情里渲染 `diagnostics`，所以现在选中 `apple-liquid-glass` 会直接看到：

> 诊断：
> • 第 2 行的值无法作为 YAML 标量解析（冒号后跟空格会被当成嵌套映射；把整个值用引号包起来即可），DSH 会因此丢弃整条技能

这个 bug 是**靠会话级证据才发现的** —— 只看宿主层或只看插件自报，两边都显示正常。

## 14. 用插件自己的编辑路径修好一条技能，并再次用会话验证

第 13 节那个 bug 的修法是改插件的判断；但 `apple-liquid-glass` 这个文件本身也确实是坏的。
用户选择"用插件自己的编辑器改写"。这件事顺带成了一次比启停更彻底的端到端验证 ——
**一次编辑直接改变了新会话所能看到的技能集合**。

`spike/repair-frontmatter.mjs` 干这件事，但它不绕开插件：目录来自 `lib/catalog.js`，
值来自 `lib/frontmatter.js` 的解析与 `quoteScalar`，写入与最终校验来自 `lib/operations.js`
的 `writeSkillContent`（先 `readSkillDocument` 校验，不合格就拒绝写入）。

两处实现细节值得记：

1. **逐行原位替换，不做"解析后拼回去"。** 第一版用 `splitDocument` 拆再拼，结果文件短了
   87 个字符 —— 因为 `splitDocument` 会把整份文档的换行统一成 LF，而这是个 CRLF 文件，
   107 个 `` 全被吃掉了。逐行替换后：改动行数 1、字节 15124 → 15142（正好是 2 个外引号
   加 16 个转义引号）、CRLF 仍是 107 个、裸 LF 0 个。
2. 备份写到插件自己的状态目录 `~/.dsh/dsh-skills-manager/backups/`，而不是技能目录旁边 ——
   放旁边有被当成技能文件扫到的风险。

`diff` 结果（只有第 3 行）：

```
3c3
< description: Build Apple-grade UI — the "macOS Liquid Glass" aesthetic — ...
---
> description: "Build Apple-grade UI — the \"macOS Liquid Glass\" aesthetic — ..."
```

改完后新建会话：

```
{"ts":"2026-09-16T05:21:41.194Z","event":"scope-snapshot","detail":"agent session-probe-1789536096960 的技能视图：共 9 条 —— apple-liquid-glass、frontend-ui-system、grill-me（模型不可用）、grilling、improve-codebase-architecture（模型不可用）、python-typed-development-standards、refactor、reverse-flow、test-driven-development"}
```

| | 会话视图 |
|---|---|
| 修复前 | 8 条，`apple-liquid-glass` 缺席 |
| 修复后 | **9 条**，`apple-liquid-glass` 在列 |

我们自己的目录同步变成 9 条、`loadable=true`。这条闭环把「读文件 → 编辑 → 写回 → DSH 真的加载」
整条链路都走通了，而不只是启停那一环。

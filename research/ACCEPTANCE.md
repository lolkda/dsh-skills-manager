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

## 9. 仍然只能由一次重载完成的观测

「停用后**活动会话**的技能目录里不再列出它」—— 直接观测需要一次真实 agent 会话。三条路都走过：

| 路径 | 结果 |
|---|---|
| `sdk-minimal` profile 跑一次性任务 | 该 profile **刻意排除 skills**，插件不会挂载 |
| web app 一次性 prompt | `dsh --profile web` 没有这个选项 |
| 直接调 `/api` RPC 建会话 | 端点由 typert 生成，未在合理成本内定位 |

用户选择自行找时间重载，所以这一项留待重载后确认。插件已为此准备好直接证据：**每个 agent 一建立就把该作用域解析出的技能写进活动日志**（`scope-snapshot` 事件）：

```
{"event":"scope-snapshot","detail":"agent <id> 的技能视图：共 9 条 —— apple-liquid-glass、…"}
```

重载后打开任意会话，这条日志就是会话级证据；此时 `GET /dsh-skills-manager/registry` 的 `scope` 也会变成 `agent`。

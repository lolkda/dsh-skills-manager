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

## 6. 仍需一次重载才能直接观测的一项

「停用后**活动会话**的技能目录里不再列出它」需要一次真实 agent 会话。用户选择自行找时间重载，因此这一项尚未直接观测，目前由两条独立证据推出：

- `test/layers.test.mjs`：同层 rank 0 胜过 preset 层的文件系统提供方（离线，真实 `dsh-skill` + `dsh-scope` + `dsh-skill-filesystem`）；
- 本记录第 3 节：真实实例里，我们的候选确实赢得了裁决（当时对手是 michengai 的提供方）。

重载后 `GET /dsh-skills-manager/registry` 的 `scope` 会变成 `agent`，那就是直接证据。

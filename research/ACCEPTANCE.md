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

## 4. 尚未直接观测的一项

「停用后**活动会话**的技能目录里不再列出它」需要一次真实 agent 会话才能直接看到。当前用户实例（3080）跑的是旧组合，本插件未加载；第二实例里没有会话。结论目前由两条独立证据推出：

- `test/layers.test.mjs`：同层 rank 0 胜过 preset 层的文件系统提供方（离线、真实 `dsh-skill` + `dsh-scope` + `dsh-skill-filesystem`）；
- 本记录第 3 节：真实实例的注册表里，我们的候选确实赢得了裁决。

重载 3080 之后即可直接观测。

## 5. 顺带发现：michengai 会遮蔽 DSH 自有技能

注册表里 8 条全部来自 `dsh-skills-manager-external`（michengai 聚合的外部目录），而 `$DSH_HOME/skills` 下真实存在的 5 条中，`grilling` **完全不在注册表里**；`grill-me` 文件里写着 `disable-model-invocation: true`，注册表却报 `model=true`。

也就是说：**michengai 不只是"多管了外部目录"，它还把 DSH 自有的技能目录整体挤出了裁决结果，并覆盖了文件自带的调用策略。**

—— 这也解释了 `research/DESIGN.md` 2.7 节那个"无法解释的现象"：本会话技能目录里 `test-driven-development`（michengai 自报停用）仍然出现，因为它的停用确实没有生效。

移除 michengai 后的直接后果：`apple-liquid-glass`、`frontend-ui-system`、`reverse-flow`、`improve-codebase-architecture` 这 4 条只存在于外部目录的技能将不再出现在目录里；而 `grilling` 等 5 条 DSH 自有技能会恢复出现。这属于既定范围决策（只管理 DSH 会读取的目录），但需要用户确认，尤其是是否要把那 4 条外部技能**导入**到 `$DSH_HOME/skills` 以免丢失。

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
   107 个 `
` 全被吃掉了。逐行替换后：改动行数 1、字节 15124 → 15142（正好是 2 个外引号
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

## 15. 完整生命周期与工具清单的会话级验证

前几轮把「启停」这一项钉到了会话级，另外四项还只有离线测试。本轮补齐 ——
`spike/lifecycle-probe.mjs` 跑完整条链路，**每一步都起一个真实会话核对**：

```
1) 新建技能
  ✔ POST /skill/create 成功 —— "probe-lifecycle"
  ✔ 磁盘上出现 SKILL.md
  ✔ 新会话里能看到它 —— 10 条

2) 用 ZIP 导入
  ✔ POST /skill/import（zip）成功 —— "probe-zipped"
  ✔ ZIP 里的附件也还原了
  ✔ 新会话里能看到导入的技能
  ✔ 先建的那条也还在

3) 删除进回收站
  ✔ POST /skill/trash 成功
  ✔ 源文件已从技能目录移走
  ✔ 回收站里能查到它
  ✔ 新会话里已经看不到它
  ✔ 没被删的那条不受影响

4) 从回收站恢复
  ✔ POST /trash/restore 成功
  ✔ 文件回到技能目录
  ✔ 新会话里又看得到它

5) 清理 → 技能目录与回收站均无残留
```

为什么每一步都要起会话：宿主层视图在真实部署里是空的（技能由 preset 层提供），
所以"目录里有没有这条技能"的唯一可信答案来自一个真实 agent 解析出的技能目录。
只查插件自己的接口，等于让被告自己作证。

### 第五项能力：Agent 工具确实到达了会话

插件自己的日志说"已注册 7 个工具"，但那只是它自称。`spike/session-probe.mjs --dump` 把
会话事件帧写下来，里面是 agent 实际拿到的工具声明（含 name / description / JSON Schema）：

```
skills_create  skills_delete  skills_get  skills_import
skills_list    skills_set_enabled          skills_update
```

### 顺带修掉的两个"自称"问题

写这套验收脚本时自己踩了同样性质的坑，一并记下：

1. 收尾清理只把临时技能**移进回收站**就打印"已全部清理"。移进回收站的东西还在磁盘上，
   而且下次建同名技能时会带着历史。现在会再扫一遍回收站并清空。
2. "回收站里没有残留"这条断言读的是**清空之前**取的快照 —— 拿旧数据断言等于没断言。
   现在清空后重新取一次目录再判。

这两条都不影响插件本身，但它们是同一类错误：**结论跑在了证据前面**。

## 16. 项目级技能根会解析到错误目录（本轮修掉）

目标里明确要求管理项目级根（`<项目>/.dsh/skills`、`<项目>/.agents/skills`）。查客户端时发现：
`request()` **从不传 `cwd`**，服务端于是退化成 `sessionCwd(ctx)` —— 取"某个会话的 cwd"。
实测同一个面板两次调用的结果：

```
不带 cwd  → cwd = C:\Users\Administrator\.dsh\profiles\web
            project-dsh@c:/users/administrator/.dsh/profiles/web
显式 cwd  → cwd = F:/project/dsh-skills-manager
            project-dsh@f:/project/dsh-skills-manager
```

会话可能有多个、顺序也不保证稳定，所以**同一个面板的两次请求完全可能落到不同项目上**，
项目级技能根会跟着换一套，而用户看不出任何异常。这正是前几轮反复出现的那类错误：
结论跑在证据前面。

三处修改：

1. `lib/routes.js`：新增 `sessionCwds(ctx)` 返回去重后的候选目录（Windows 路径大小写不敏感、
   结尾斜杠等价，统一后去重）；`/catalog` 响应同时给出 `cwd`（实际用来解析的那个）与
   `candidates`。`sessionCwd()` 保留为"取第一个"，但文档写明它只是默认值。
2. `client/client.js`：第一次拿到服务端解析出的 `cwd` 就**钉住**它，此后每次请求都显式用
   `?cwd=` 带回（一处闭包变量，9 个调用点自动覆盖）。
3. 界面显示"项目根按 <目录>"；候选多于一个时给选择器，由用户决定，而不是替他猜。

真机复验（`dsh web --port 3099`）：

```
不带 cwd  → cwd = C:\Users\Administrator\.dsh\profiles\web   candidates = []
显式 cwd  → cwd = F:/project/dsh-skills-manager
两种情况下 project 根的 key 与路径都随之改变 —— 这正是修复要保证的
```

改完重跑完整生命周期，17 项全过；测试 87 项全通过。

## 17. 项目级技能根：一个"不报错的漏报"（本轮修掉）

目标里要求管理项目级根，但前几轮真机验证里**一个项目技能都没出现过** —— 全部来自
`$DSH_HOME`。本轮造了一个真的带 `.git` 的项目目录，放进项目技能，起真实会话说。

第一次跑：

```
1) 会话的工作目录就是该项目时
  ✖ 看得到 .dsh/skills 下的项目技能
  ✖ 同名时项目版胜出（rank 100 胜过 400） —— probe-shadow   ← 没有"模型不可用"标记
  ...
  ✔ 项目技能在目录里以项目根胜出 —— project-dsh@d:/personal/temp/dshsm-proj-...
```

看起来像"插件报了模型看不到的技能"。但把会话事件帧 dump 出来一看，**系统提示里明明列着
`diag-proj`** —— 模型收到了，是我们的**诊断**漏报了。

根因：`snapshot()` 少一个 `cwd` 不会失败，只会**少掉项目级根**。`describeScope()` 与
`/registry` 都没传 agent 自己的 cwd，于是注册表视图里没有项目技能，而系统提示里有。
`dsh-tool-skill` 用的是 `agent.session.header.cwd`（源码里三处都是它），本插件照抄即可。

修复：`lib/scope.js` 新增 `agentCwd(agent)`，`agentScopeView` 优先用它、拿不到才退回调用方
给的 cwd —— 顺序不能反，因为缺 cwd 的后果是**静默漏掉一层根**，而不是报错。

修完再跑，16 项全过：

```
1) 会话的工作目录就是该项目时
  ✔ .dsh/skills 与 .agents/skills 下的项目技能都进入了会话的注册表视图
  ✔ 两条都出现在**模型收到的系统提示**里
  ✔ 同名时项目版胜出（rank 100 胜过 400） —— probe-shadow（模型不可用）
2) 换了工作目录后
  ✔ 项目技能不再出现（注册表视图与系统提示都看不到）
  ✔ 同名技能此时由用户版提供，且可用
3) 对项目根的技能做启停
  ✔ 停用后新会话里变成模型不可用
  ✔ **被停用后，模型收到的目录里已经没有它了**
  ✔ 源文件仍然没有被改动
4) 清理
  ✔ 临时项目与用户侧的临时同名技能都已删除
```

第 3 步最后那条是本项目能拿到的最强证据：不是"插件说自己停用了"，而是**模型实际收到的
技能清单里那条不见了**。而且它作用在一个**项目根**的技能上（rootKey 形如
`project-dsh@d:/personal/temp/...`），不是只在 `$DSH_HOME` 上验证过。

顺带记一条方法论：这轮的探针同时取**两份视图** ——
`registry`（插件从注册表读到的）与 `prompt`（模型真正收到的系统提示）。
只看前者，就是让被告自己作证；两者不一致，才说明插件在骗人。这轮的分歧正是这么发现的。

## 18. customSkillDirs 与 bundled：目标列的六类根全部验证完，以及一个一致性检测器

目标列了六类根。前几轮验证了四类（`$DSH_HOME/skills`、`~/.agents/skills`、项目
`.dsh/skills` 与项目 `.agents/skills`），剩下 `customSkillDirs`（rank 300）与
`bundled`（rank 600）在当前环境里**都是空的**：`customSkillDirs` 默认 `[]`，
`bundledSkillDir` 来自 `DSH_BUNDLED_SKILL_DIR` 且未设置。所以要配出来才能验。

### 先说一个结构性问题

本插件与 `dsh-skill-filesystem` **各有一份配置**（同名选项：`customSkillDirs`、
`bundledSkillDir`、`includeDefaultRoots`、`dshHome`、`agentsHome`），两边没有任何机制保证
一致。一旦分叉：

- 我们多报 → 界面上有这条技能，模型却从来收不到；
- 我们少报 → 技能实际在生效，界面上却看不见。

两种都不报错。所以加了 `lib/divergence.js`：把本插件算出的清单与**注册表里 DSH 实际解析
出的那一份**逐条比对，只取 `provider === 'filesystem'` 的条目（本插件的 overlay 也注册在
同一个注册表里，把它算进来就成了自己跟自己比）。结果写进每个会话的活动日志，也出现在
界面上。

### 让检测器响一次

一个永远说"一致"的检测器比没有更糟。所以先故意造出分歧：只给本插件配 `customSkillDirs`，
DSH 那边不动。

```
本插件多报了 1 条（DSH 里没有）：probe-custom
```

它响了，而且点的是名。

### 两边都配上之后

```
会话技能视图：共 10 条 —— ... probe-custom ...；与 DSH 实际解析一致（10 条）
模型收到的系统提示里出现 probe-custom：1 次
```

`customSkillDirs` 端到端打通：配上 → 本插件发现（rank 300）→ DSH 读取 → **送进模型** →
两边一致。

`bundled` 同理，走环境变量：

```
DSH_BUNDLED_SKILL_DIR=... 会话技能视图：共 10 条 —— ... bundled-skill ...；一致（10 条）
模型收到的系统提示里出现 bundled-skill：1 次
```

（`spike/session-probe.mjs` 因此新增 `--bundled <目录>`，把环境变量只喂给这一场会话。）

至此目标列的六类根**全部有真机证据**。

### 界面

面板现在同时拉 `/catalog` 与 `/registry`：

- 一致 → 绿色提示「已与 DSH 实际解析核对：N 条一致」——一句**经过实测**的话，不是插件自称；
- 不一致 → 红色提示，分别点名"多报了哪些（模型收不到）"与"少报了哪些（界面看不到）"；
- 没有可用 agent 视图 → **什么都不说**，不假装核对过（`checked: false` 带原因）。

真机上两条路径都验过：无 agent 时 `/registry` 返回
`{"checked":false,"reason":"当前没有可用的 agent 视图，拿宿主层去比只会得到假差异"}`；
有 agent 时报「与 DSH 实际解析一致（9 条）」。

顺带修了一个防护缺失：目录里若出现 `null` 记录，比对会把 `/registry` 与活动日志一起打挂。

## 19. 浏览器半边真的会被加载吗：从源文件到渲染出的面板

前几轮客户端都是用**仓库里的源文件**在自写的 mini React 运行时里测的。但从源文件到浏览器之间
还有好几步：服务端要认出 manifest 里的 `dsh.client.platform: web`、把它登记进客户端模块表、
给出带 `rev` 的 URL、再把文件送出去。任何一步断了，用户重载后看到的就是一个空面板，而仓库里
的测试**全都是绿的**。这条链路此前一次都没验证过。

### 服务端确实登记了它

首页 HTML 里能找到：

```
"id":"@lolkda/dsh-skills-manager",
"url":"/plugins/??@lolkda/dsh-skills-manager/client.js&rev=936e48f02fd1d263-51",
"inject":["@deepseek-ai/dsh-client-ui-settings"]
```

预载清单里 174 个客户端插件，本插件在其中；连 manifest 里的 `client.inject` 都被正确读到。

### 送出的字节与源文件一致

```
HTTP 200  40658 bytes     （源文件 40559 bytes）
唯一差异：末尾被追加 `;` 与 `//# sourceMappingURL=...`
```

### 把这些字节放进运行时

`spike/client-bundle-probe.mjs` 取的是那条带 `rev` 的 URL 的**真实响应**，不是本地文件
（`test/helpers/client-harness.mjs` 的 `loadClient` 因此新增 `source` 选项）：

```
✔ 服务端把本插件登记进了客户端模块表
✔ manifest 里的 client.inject 被正确读到
✔ 客户端 bundle 能取到 —— HTTP 200
✔ 模块名正确 / inject 正确 / 注册了一个设置区块 / 区块标签是「技能」/ 注入了一份样式
✔ 面板真的渲染出了技能名
✔ 渲染出了核对结论
✔ 面板真的去调了后端接口
```

没有可用的无头浏览器（puppeteer/playwright/系统 Chrome 都没有），所以这是不装浏览器的前提下
能做到的最强证据：**服务端实际送出的那些字节，确实能注册出技能面板并渲染出来**。

### 顺手补上「正文查看与编辑」的真机端到端

五项能力里只有这一项此前没走过真实 HTTP（第四轮是借"修 apple-liquid-glass"顺带验证的）。
现在 `spike/lifecycle-probe.mjs` 多了一步：

```
2.5) 编辑正文
  ✔ GET /skill/content 读到正文
  ✔ POST /skill/save 保存成功
  ✔ 改动后的描述出现在**模型收到的系统提示**里
  ✔ 非法 frontmatter 被拒绝 —— "document.invalid"
  ✔ 被拒绝的保存没有碰磁盘上的文件
```

最后两条是安全属性：这个插件的写入路径能改磁盘上的技能文件，最坏的失败是写进去一份 DSH
读不动的文档 —— 那条技能会**静默从所有会话里消失**。所以"写坏会被拦住、且磁盘零改动"必须
是被测过的事实，而不是设计意图。

写这步时踩了一次"测试其实没测到东西"：第一版"非法"样本的 description 里**根本没有冒号**，
于是那次保存是合法的，报错的是我的夹具而不是代码。改掉样本里的冒号后才真正测到拒绝路径。

## 20. 七个 Agent 工具：从"注册成功"到"叫得动"

第四轮验证过 7 个 `skills_*` 工具确实出现在会话的工具清单里（带完整 name/description/JSON
Schema）。但那只证明**它们被送出去了**，不证明**叫得动**。翻测试才发现：整套工具此前只被断言过
"注册了、有 `execute`"，**没有任何一处真正调用过任何一个 handler**。而真机会话里模型也调不动
它们（本机没有 API key，模型不会回一个工具调用）—— 于是这套 CRUD 的执行路径从头到尾没跑过，
连参数名写错都发现不了。

补 `test/tools.test.mjs`，逐个真调，并连 `output.render` 一起测（那是模型最终看到的话）：

| 工具 | 真实验证到的行为 |
|---|---|
| `skills_list` | 列出刚建出来的技能 |
| `skills_get` | 取回的正文里确实有写进去的内容 |
| `skills_create` | 磁盘上真的出现 SKILL.md |
| `skills_update` | 文件被改写；**非法文档被拒且磁盘零改动** |
| `skills_set_enabled` | 覆盖真的落进状态；**源文件零改动**；清除后不留 null |
| `skills_delete` | 源文件移走、列表里不再出现、结果给出回收站条目 |
| `skills_import` | Markdown 文件 / 目录（附件一起搬）/ ZIP 三种都吃；路径不存在时给可读失败 |

外加一条契约断言：**这些工具刻意不接受 `rootKey`** —— 它们只写用户根
（`$DSH_HOME/skills`）。不该让模型随手挑一个根去写；要跨根启停，`skills_set_enabled` 会自己
找到胜出的那条并作用于它所在的根。参数表里 `additionalProperties: false`，多传的字段会被框架
挡在门外。

### 写这轮测试时，三次失败里有三次都是**我的假设**错了

- 我以为 `skills_set_enabled` 的覆盖是裸布尔，实际是 `{ enabled }`；
- 我以为 `skills_import` 能吃内联 `content`，实际只吃路径；
- 我以为工具接受 `rootKey`，实际刻意不接受。

没有一条是代码的 bug，但每一条都说明同一件事：**"读代码觉得对"和"真的调一次"之间隔着的东西
比想象中多**。这三条如果留着，看代码的人（包括我）会一直以为工具接受 `rootKey`。

## 21. 全链路：界面表单 → 真实路由 → 磁盘

此前两边各测各的：客户端测"渲染对不对"，服务端测"接口对不对"。中间靠**字段名**连着，而那个
契约**从来没人验过** —— 客户端表单一次都没被驱动过（只测了渲染），服务端的 `/skill/import`、
`/skill/content`、`/trash/purge` 也没有任何 HTTP 层测试。字段名写错的话，两边测试全绿，用户
点下去却什么都不会发生。

新增 `test/fullstack.test.mjs`：把客户端发出的**真实请求**喂给**真实路由**，然后到磁盘上看结果。

```
✔ 界面新建技能：字段真的走到了磁盘上
    body 的字段与服务端 dispatch 读的逐个对上：[body, description, name, rootKey, whenToUse]
    磁盘上真的出现了 skills/ui-created/SKILL.md
✔ 界面新建：名字非法时把话说出来，而不是静默什么都不发生
✔ 界面导入技能：从路径导入走过的字段是真的
    [kind, overwrite, path, rootKey]，导入结果落到磁盘
✔ 界面查看与保存正文：改动落盘，界面里也读得到
    /skill/content 带上 rootKey 与 name；[content, name, rootKey]；改动进了文件
✔ 界面删除进回收站，再从回收站恢复
    [name, rootKey] 与 [id]；源文件先消失、恢复后回来
```

顺手把宿主夹具（`boot` / `call`）抽成 `test/helpers/host-harness.mjs`，两个测试文件共用一套
真实环境，而不是让全链路测试对着假接口自说自话。

### 过程中三件事只有真跑起来才知道

1. `textOf()` 把 **className** 也拼进了结果，于是按钮文案变成
   `dshsm-btn dshsm-btn--primary 新建技能`，按文案精确匹配永远找不到按钮；
2. 表单是 `setFields({ ...fields, [key]: value })`，拿着**更新前的旧节点**连写两个字段，
   第二次会用旧 `fields` 把第一次覆盖掉 —— 真浏览器里每个事件各自渲染一次，所以测试里也必须
   每次重新定位节点；
3. 导入表单的第一个 `input` 是 `type=file`，路径输入框是第二个；编辑器的容器 class 是
   `dshsm-editor` 而不是 `dshsm-form`。

### 一次没解释清楚的偶发，修掉了

全量跑时出现过一次 2 项失败，单跑却全过。没有把它当成噪声：根因是 harness 的 `flush()` 只等
**固定 8 个节拍**，而全链路里 fetch 走的是真实文件 I/O，负载高时一次往返可能超过 8 个节拍，
断言就跑在数据到达之前。

改成盯**在飞的请求数**：连续 3 个节拍都归零才算安静。偶发的测试比没有测试更糟 —— 它会让人
开始不信任整套测试。

## 22. 真实浏览器：在真 Chrome 里把界面打开一次

前几轮客户端都是用自写的 mini React 运行时测的。那能证明"服务端送出的字节能注册出面板"，
但证明不了真实 React、真实插件加载器、真实 DOM 这一整套 —— 而用户看到的正是后者。

机器上有 Chrome，Node 24 又自带 `WebSocket`，于是用 CDP（就是一个 WebSocket 上的 JSON-RPC）
直接驱动真实浏览器，**不装任何 npm 包**，用独立的 `--user-data-dir` 起进程，不碰用户正在用的
那个实例。见 `spike/browser-probe.mjs`。

真实浏览器里的结果：

```
✔ 页面加载完成 / 应用挂载完成             标题：DeepSeek Harness
✔ 本插件的样式注入到了真实 DOM 里         已注入的插件样式里有 dsh-skills-manager
✔ 点得到设置入口 —— 设置
✔ 设置里找得到「技能」条目
✔ 技能行渲染出来了
✔ 读到了技能名 —— apple-liquid-glass、frontend-ui-system、grill-me、grilling、
                 improve-codebase-architecture、python-typed-development-standards、
                 refactor、reverse-flow
✔ 标签页（技能 / 回收站）在 —— 技能 9 / 回收站
✔ 显示了项目根的解析依据 —— 项目根按 F:\project\抖音 解析 .dsh/skills 与 .agents/skills
     面板提示：已与 DSH 实际解析核对：9 条一致
✔ 页面没有报错 —— （无）
```

顺带确认了槽位契约：设置里的条目顺序是
`通用设置 | 手机访问 | 模型 | 插件 | Agent 预设 | 插件市场 | 提示词 | 技能` ——
本插件排在 `提示词`（prompt-manager，order 61）之后。

### 在真实 DOM 里点开关，并做独立验证

这一条是目标里最硬的要求：**启停必须真实作用到活动会话**。做法是在真实浏览器里点真实开关，
然后**不看界面**，去看模型实际收到的系统提示词：

| 步骤 | 证据 |
|---|---|
| 点「grilling」的开关（关） | 真实 `POST /dsh-skills-manager/policy`，体 `{"rootKey":"dsh","name":"grilling","enabled":false}` |
| 界面自己怎么说 | 行标签变成 `user-dsh / 手动停用`；开关无障碍名 `停用 grilling` |
| **独立视图：会话** | 系统提示词里 `grilling` **未出现**；`apple-liquid-glass`、`refactor` 等照旧出现 |
| 再点一次开关（开） | 真实 `POST … {"enabled":true}`；行标签 `手动启用` |
| **独立视图：会话** | `grilling` **重新出现** |
| 源文件 | 全过程 `sha256` 一字节未变 |
| 清理 | `state.json` 回到 `{"version":1,"overrides":{}}` |

只问界面是让被告自己作证。所以每一步都另开一个会话读提示词来对。

（`grill-me` 本来就不进模型提示词 —— 它是用户手动调用的技能，不是漏报。）

## 23. 真实浏览器里走完剩下三项能力

第 22 节在真实浏览器里只验了「列表」和「启停」。另外三项能力 —— 正文查看与编辑、新建、删除 +
回收站 + 恢复 —— 此前只在全链路测试（真实客户端代码 + mini React）里验过。mini React 终究是
我写的：这一轮在真 Chrome 里把整条链走了一遍，**32 项检查全通过**：

```
新建：打开表单 → 填名字 → 填正文 → 点创建 → 列表里出现 → 磁盘上出现 SKILL.md
编辑：选中它 → 打开编辑器 → 编辑器里是这条技能的原文 → 改正文 → 保存
      → 编辑器关闭（服务端接受了）→ 改动真的写进了磁盘
删除：选中它 → 移到回收站 → 列表里不再有它 → 源文件已从技能目录移走
      → 切到回收站标签 → 回收站里能找到它
恢复：点恢复 → 回收站条目消失 → 文件回到技能目录 → 内容一字不差
清场：切回技能标签 → 选中它 → 再移进回收站 → 切到回收站 → 永久删除
      → 回收站里也没了 → 磁盘上不留痕迹
```

### React 受控输入：直接改 `el.value` 是没有用的

这是真实浏览器里第一个真会咬人的地方。React 的 value tracker 记着上一次的值，直接赋值它认为
"没变"，`onChange` 根本不触发 —— 表单看起来填好了，点提交却是空的。必须走**原生 setter**再派发
一个会冒泡的 `input` 事件，也就是浏览器里"人真的打字"的样子：

```js
Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text)
el.dispatchEvent(new Event('input', { bubbles: true }))
```

### 验收工具自己污染了被验收的环境

第一次跑的时候，清场那几步因为我的疏忽失败了：**恢复之后界面还停在回收站标签页**，那里已经没有
那条技能，我却直接去找它的行 —— 找不到，后面全垮，于是 `browser-probe-tmp` 真的留在了
`$DSH_HOME/skills` 里，还进了模型可见的技能清单。验收工具本身污染被验收的环境，是最不该发生的
那类事故。

修法有两层：

1. 先把流程修对（恢复之后先切回「技能」标签再操作）；
2. 在 `finally` 里加一道**兜底**：不管演练在哪一步炸了，都把临时技能从磁盘上删掉。清理逻辑不能
   只在"一切正常"的路径上存在。

### 临时目录：三个办法里只有一个能用

浏览器探针每次要在临时目录建一个 Chrome profile，跑完删掉。删不掉，每跑一次留十几兆。查的过程
排除了三个猜测：

- `child.kill()` 在 Windows 上只杀直接子进程 → 改用 `taskkill /T`，还是删不掉；
- 以为句柄释放慢 → 重试 20 秒，还是 EPERM；
- 退回 `cmd rmdir /s /q`，连里面的文件都没删掉。

再往下查，还有一个**自己的假设也是错的**：以为"退出后重试够久总能删掉"，于是交了个脱离的PowerShell 重试三分钟 —— 150 秒后目录还在，而那一刻机器上**连一个 chrome 进程都没有**（无头的也没有）。没有任何进程持有时还删不掉，最像的原因是杀毒软件在扫描刚写出来的几千个小文件、句柄要几分钟才放。

所以最终不做无用功：**开跑前先用 PowerShell 清扫上一次的残留**（这条路径实测有效，也确实每次都扫掉了），本次留下的一个则在备注里点名，并给出立刻清理的命令。清理逻辑写错了不要紧，**写错了还静默吞掉**才是问题。

### 矩阵里最后那一格：导入

上一节在真实浏览器里走完了新建/编辑/删除/恢复，但「导入」只走了「按路径」——上传 ZIP 和上传
单个 Markdown 这两条分支**在真实浏览器之外一次都没跑过**，因为 `readBase64` 用的是 `FileReader`，
自写的 mini React 运行时里根本没这个 API。用 CDP 的 `DOM.setFileInputFiles` 把真实文件塞进文件
选择框（和用户点"选择文件"同一个效果），三条分支全通过：

```
✔ 导入：把 ZIP 塞进文件框        → 磁盘上出现了它
✔ 导入：把单个 Markdown 塞进文件框 → 磁盘上出现了它
✔ 导入：填上本机路径 → 点从路径导入 → 磁盘上出现了它
✔ 导入：三条都出现在技能列表里
✔ 导入：清理干净
```

至此五项能力在**真实浏览器**里都有实测证据：列表、启停（并把结果对到模型实际收到的系统提示词）、
正文查看与编辑、新建与导入（ZIP / 文件夹 / 单个 SKILL.md）、删除+回收站+恢复。

## 24. 一个只有真去查才会发现的 schema 缺陷

起因是想确认"模型到底能不能调这些工具"。查 DSH 怎么校验工具参数时发现：`ctx.tools.register`
**只校验 `output.schema`，完全不看 `parameters`** —— 参数表写错，注册期一路绿灯。

接着看 DSH 支持的 JSON Schema 子集，发现一条硬规则：

```
.type must be a single type string (type arrays are not supported)
```

而 `skills_set_enabled` 用的正是 `type: ['boolean', 'null']`（三种状态：启用 / 停用 / 清除，
"清除"用 `null` 表达）。**它是整个工具生态里唯一一处联合类型** —— DSH 自己的工具里
`type: [...]` 和 `nullable` 都是零处。用 DSH 自己的校验器实测：

```
DSH 校验器拒绝: unsupported JSON schema: schema.properties.enabled.type
                must be a single type string (type arrays are not supported)
渲染成 TS 类型: "unknown"
```

也就是说：这个工具的 schema 通不过 DSH 的校验，而且 `jsonSchemaToTs` 会把**整份参数**渲染成
`unknown` —— 在按 schema 渲染签名的模式下，模型看到的参数表形同没有。参数是被原样透传给 provider
的（`schemaOf()` 只做一次 JSON 快照），所以今天大多数 provider 可能照单全收，**失败与否取决于
provider，而且是静默的**。

### 修法：把"清除"从 `null` 改成**省略**

`enabled` 变成单个 `boolean`，`required` 只剩 `name`：传 `true`/`false` 是设定，**省略**就是清除。
三种状态一个不少，全部落在子集内。

这是对工具接口的破坏性改动，但包还没发布，没有外部调用方 —— 与其留一个"看 provider 脸色"的参数
类型，不如现在就改对。内部 API 不受影响：`runtime.setEnabled({ enabled: boolean | null })` 和
界面用的 `/policy` 路由仍然用 `null` 表示清除。

### 回归测试用 DSH 自己的校验器

```
assertSupportedJsonSchema(definition.parameters)              // 落在子集里
jsonSchemaToTs(definition.parameters) 里不能出现 "unknown"     // 能渲染出真实类型
```

不照着源码重写一遍规则：规则会随 DSH 变，重写的那份不会。

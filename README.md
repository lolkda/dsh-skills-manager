# @lolkda/dsh-skills-manager

在 DeepSeek Harness 的 Web 界面里管理 DSH **自己会读取**的技能目录。

它只做一件事，并且把它做透：让「这个技能现在到底会不会被加载」这个问题有唯一、可验证的答案。

- **列表** —— 按 DSH 的真实根目录顺序列出技能，标明来源、rank、重名遮蔽关系。
- **启停** —— 改变 DSH 里的调用策略，**不改动源文件**。随时可撤销。
- **正文查看与编辑** —— 直接读写 `SKILL.md`，带 frontmatter 诊断。
- **新建 / 导入** —— 目录 bundle、平铺 `.md`、ZIP 包。
- **删除** —— 永久删除，带二次确认（没有回收站）。
- **Agent 工具** —— 模型也能列出、读取、创建、启停技能。

## 它管理哪些目录

与 `@deepseek-ai/dsh-skill-filesystem` 的默认根**逐条对齐**，因为策略覆盖必须落在文件系统提供方真正会读到的那些技能名上：

| rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<项目根>/.dsh/skills` |
| 200 | `project-agents` | `<项目根>/.agents/skills` |
| 300 | `custom` | 配置里的 `customSkillDirs` |
| 400 | `user-dsh` | `$DSH_HOME/skills` |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills` |
| 600 | `bundled` | `$DSH_BUNDLED_SKILL_DIR`（只读） |

项目根 = 含 `.git` 的最近祖先目录。**刻意不聚合** cc-switch、Codex、Claude、Cursor 等其他 Agent 的目录 —— 那些不是 DSH 会读的东西，把它们混进这个列表只会让上表这个唯一答案变得含糊。

## 启停是怎么实现的

不改文件，是因为改文件既危险又不可逆：注释会被吃掉、未知的 frontmatter 键会丢失、用户自己写的 `disable-model-invocation` 会被抹掉，而且卸载插件后无法恢复。

实际做法是向 `ctx.skills` 注册一个**覆盖提供方**：

- 只对**被显式启停过的技能**发出候选，rank 取 `0`（低于文件系统提供方的 100–600）；
- 注册表的规则是「同层内 rank 小者胜」，因此这些名字的裁决必然被覆盖候选赢得；
- 候选的 `invocation` 就是用户要的策略，`get()` 仍返回真实正文，所以「启用」的技能照常可加载；
- 取消覆盖，该技能立刻回到文件自己的声明。

关键细节：`dsh-skill` 的注册表按 scope 分层，而 **agent preset 会再挂一次 `dsh-skill-filesystem`、注册进 preset 自己的层**（见 `dsh-agent-presets/presets/standard/agent.cordis.yml`）。读取时「最近层直接赢得重名」，所以只在宿主层注册覆盖**会被 preset 层压掉**。本插件因此在宿主行和每个 agent 作用域**各注册一次**（`ctx.on('agent/created')` + `agents.list()`，经 `agent.ctx.get('skills')`）。

这条机制有测试为证：`test/registry.test.mjs` 挂的是**真实的** `dsh-skill` + `dsh-skill-filesystem`，断言取自 `ctx.skills.snapshot()` —— 与模型最终看到的会话目录同源。

## 安装

```powershell
dsh plugin --profile web add @lolkda/dsh-skills-manager@latest --registry=https://registry.npmjs.org/
dsh --profile web --dump-config   # 确认配置里出现 dsh-skills-manager
```

从本地源码迭代（宿主半边改动需要重载 profile）：

```powershell
dsh plugin --profile web add link:F:/project/dsh-skills-manager
```

## 配置

在 profile 自己的 `cordis.patch.yml` 里用 id 定向 patch 覆盖（该层在每个 bundle 层之后应用）：

```yaml
- id: dsh-skills-manager
  name: '@lolkda/dsh-skills-manager'
  config:
    customSkillDirs: ['F:/shared-skills']
    bundledSkillDir: 'F:/dsh/bundled-skills'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `includeDefaultRoots` | `true` | 是否包含项目根与用户根 |
| `customSkillDirs` | `[]` | rank 300 的额外根 |
| `bundledSkillDir` | `$DSH_BUNDLED_SKILL_DIR` | rank 600 的内置根，只读 |
| `dshHome` / `agentsHome` | `$DSH_HOME` / `$DSH_AGENTS_HOME` | 根目录解析基准 |
| `log` | `true` | 是否写 `$DSH_HOME/dsh-skills-manager/dsh-skills-manager.log` |

状态落在 `$DSH_HOME/dsh-skills-manager/state.json`，**只存显式覆盖**，不缓存任何从磁盘推导出的内容。

## 验收：不信自报，读注册表

`GET /dsh-skills-manager/registry` 返回 `ctx.skills.snapshot()` 的真实解析结果 —— 每个技能最终赢得的 `invocation`、胜出提供方、来源。启停是否生效由它判定，而不是由本插件自己的状态接口自称：

```powershell
curl -H "Host: 127.0.0.1:3080" http://127.0.0.1:3080/dsh-skills-manager/registry
```

响应里的 `scope` 字段说明它读的是哪一层，这一点很关键：

- `scope: "host"` —— 没有任何活动会话，读到的是宿主层。**真实部署里宿主层通常一条技能都没有**：技能由 preset 层提供，而 `dsh-skill` 的候选来自 `[layers.global, ...chainLayers(scope)]`。
- `scope: "agent"` —— 有会话，`skills` 是该 agent 所在层链的合并结果，也就是模型真正看到的那一份。`host` 字段仍然给出宿主层视图供对照。

读与写在作用域上是不对称的，写代码时几乎必然踩一次：

| 方向 | 作用域从哪来 |
|---|---|
| 写 `registerProvider` | 从调用上下文推断（`scopeOf(this.ctx)`） |
| 读 `snapshot` / `get` | **只**看 `options.scope`，不从上下文推断 |

所以「从 agent 的 ctx 上调 `snapshot({})`」看起来合理，实际读到的是 global 层的空结果。`lib/scope.js` 负责把这层差异收进一个地方。

活动日志里每个 agent 建立时会记一条 `scope-snapshot`，写明**那个会话**解析出的技能清单 —— 排查「为什么这个会话里没有它」看这里，而不是看插件自己的状态接口。

### 与 DSH 实际解析的一致性核对

`/registry` 的响应里有一个 `divergence` 字段：把**本插件自己算出的清单**与**注册表里 DSH 实际解析出的那一份**逐条比对（只取 `provider === "filesystem"` 的条目 —— 本插件的 overlay 也注册在同一个注册表里，算进来就成了自己跟自己比）。

为什么需要它：本插件与 `dsh-skill-filesystem` **各有一份配置**（`customSkillDirs`、`bundledSkillDir`、`includeDefaultRoots`、`dshHome`、`agentsHome`），两边没有任何机制保证一致。分叉的后果是：

- 我们多报 → 界面上有这条技能，模型从来收不到；
- 我们少报 → 技能实际在生效，界面上看不见。

**两种都不会报错**，只能主动比出来。界面上一致时显示「已与 DSH 实际解析核对：N 条一致」，不一致时分别点名「多报了哪些（模型收不到）」与「少报了哪些（界面看不到）」；没有可用会话视图时什么都不显示，不假装核对过。

每个会话建立时，活动日志里的 `scope-snapshot` 也会带上这句结论：

```
agent session-... 的技能视图：共 9 条 —— apple-liquid-glass、grill-me（模型不可用）、...；与 DSH 实际解析一致（9 条）
```

### 覆盖只改变调用策略，不改变技能的其它性质

覆盖提供方的候选会**整条**取代文件系统的候选（同层 rank 0 胜出），所以它必须把技能原有的字段
一并带过来。`whenToUse` 曾经漏掉：一条技能**只要被启停过一次**，它的 `whenToUse` 就会对所有下游
消费者消失 —— 界面看不出来，注册表也不报错，只是那条信息没了。现在原样带过来，`test/layers.test.mjs`
里有一条守门测试（去掉转发即失败）。

本插件**不往候选的 `metadata` 里写自己的标记**：那个字段是**整份替换**而不是合并，写了会连带丢掉
技能自己 frontmatter 里的 `metadata` —— 而本插件的 frontmatter 解析器刻意不解析嵌套映射，复现不了
它。反正 DSH 现在没有任何地方读 `skill.metadata`，写了没人看却换掉一个真实字段，不划算。策略覆盖的
信息由本插件自己的接口（`/overrides`）给出。

### Agent 工具的参数表只用 DSH 支持的 JSON Schema 子集

`ctx.tools.register` 会校验 `output.schema`，但**完全不校验 `parameters`** —— 参数表写错在注册期
一路绿灯，问题要到模型那边才显形。所以 `test/tools.test.mjs` 里直接用 **DSH 自己的**
`assertSupportedJsonSchema` 把七个工具的参数表逐个过一遍（用它的校验器，而不是照着源码重写一遍
规则：规则会随 DSH 变，重写的那份不会）。

DSH 支持的子集里 `type` **只能是单个字符串**：`type: ['boolean','null']` 会被直接拒掉，而且
`jsonSchemaToTs` 会把整份参数渲染成 `unknown` —— 在按 schema 渲染签名的模式下，模型看到的参数表
形同没有。因此 `skills_set_enabled` 的三种状态里，「清除覆盖」由**省略 `enabled`** 表达，而不是
传 `null`。

（内部 API 不受这个限制：`runtime.setEnabled({ enabled: boolean | null })` 与界面用的
`/policy` 路由仍然用 `null` 表示清除。）

### Agent 工具只写用户根

暴露给 Agent 的七个 `skills_*` 工具**不接受 `rootKey`**：新建与导入一律落在用户根
（`$DSH_HOME/skills`）。不该让模型随手挑一个根去写。要跨根操作，`skills_set_enabled` 会自己
找到当前胜出的那一条，并作用于它所在的根（包括项目根与只读的 bundled 根 —— 后者只允许启停，
不允许改文件）。参数表里 `additionalProperties: false`，多传的字段会被框架挡在门外。

### `loadable` 的含义是「DSH 会不会真的加载它」

DSH 用真正的 `yaml` 库解析 frontmatter，任何解析失败都会让**整条技能被丢弃**。本插件是手写的 YAML 子集，所以对这类写法一律**明确报错**，而不是"能读出来就算数"：

```
--- 
name: demo
description: 参考 macOS): 浅灰白底        # 冒号后跟空格 = YAML 嵌套映射 = DSH 整条丢弃
---
```

这样的技能在界面上标红「不可加载」、开关禁用，详情里给出原因和修法（把整个值用引号包起来）。
它也不参与同名仲裁 —— 既然 DSH 看不到它，它既不能胜出，也不能把后面真正会被加载的那条挤成"被遮蔽"。

理由很直接：**这个插件最容易犯的错，是声称一条模型从未收到过的技能"生效"。** 那比不做还糟。

路由前缀为什么不放在 `/api` 下：`dsh-client-connection` 用 `{kind:'prefix', path:'/api'}` 注册了一个鉴权路由，而前缀路由**先注册先匹配**；本插件的 bundle 排在 profile 末尾，于是所有 `/api/*` 请求恒定 401。`@lolkda/dsh-prompt-manager` 早已用非 `/api` 前缀绕开这一点。

## 从 michengai 迁移

`@michengai/dsh-skills-manager` 会聚合 `~/.cc-switch/skills`、`~/.codex/skills`、`~/.claude/skills` 这些**外部**目录，其中一部分技能在 DSH 自有目录里并不存在。移除它之后那些技能会一起消失 —— 它们本来只是靠那个插件才可见。

把它们导入到 `$DSH_HOME/skills` 之后再移除，技能就不会丢：

```powershell
node scripts/migrate-external-skills.mjs --dry-run   # 先看会做什么
node scripts/migrate-external-skills.mjs             # 默认不覆盖同名技能，可重复运行
```

脚本复用插件自己的 `importDirectory`，因此语义与界面上的「导入」完全一致：文档统一落成 `SKILL.md`，目录名取自 frontmatter 的 `name`（例如 `apple-design-skill-project` 会落成 `apple-liquid-glass`），附属文件原样保留。

## 开发

零构建步骤：宿主半边是手写 ESM JS，浏览器半边是客户端模块系统的手写懒 CJS 工厂，因此不存在「改了源码忘了构建」这一类失败模式。

```powershell
node --test                      # 全部测试：单元 + 真实注册表集成 + 分层遮蔽 + 客户端契约
node spike/registry-probe.mjs    # 一次性机制探针：打印三个场景下的胜出者
```

改动宿主半边后需要重载 profile 才生效：

```powershell
dsh plugin --profile web add link:F:/project/dsh-skills-manager
```

工程约定与已实测的机制细节见 `research/DESIGN.md`，真机验收证据见 `research/ACCEPTANCE.md`。

## 许可

MIT

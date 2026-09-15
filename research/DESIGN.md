# dsh-skills-manager 设计稿

> 本文件记录**已实测验证**的事实与据此确定的设计。凡未实测的推断都显式标注「待验证」。

## 1. 目标

自研 DSH Web 插件 `@lolkda/dsh-skills-manager`，替换已安装的第三方 `@michengai/dsh-skills-manager`，用于管理 **DSH 自身会读取的技能目录**。

明确不做：聚合 cc-switch / codex / claude / cursor 等外部 Agent 目录。

## 2. DSH 技能子系统（实测）

### 2.1 三层结构

| 层 | 包 | 职责 |
|---|---|---|
| 注册表 | `@deepseek-ai/dsh-skill` | `ctx.skills`：合并各提供方目录、裁决重名、按需加载 |
| 提供方 | `@deepseek-ai/dsh-skill-filesystem` | 从磁盘发现 `SKILL.md` / `<name>.md` |
| 消费方 | `@deepseek-ai/dsh-tool-skill` | 渲染会话目录、`skill` 工具、`/name` 用户调用 |

### 2.2 挂载点（实测自 `dsh-base/cordis.patch.yml:273-285` 与 `dsh-agent-presets/presets/standard/agent.cordis.yml:79-88`）

- **宿主平面**（`@deepseek-ai/dsh-base`）挂：`dsh-skill`(273)、`dsh-skill-filesystem`(276)、`dsh-tool-skill`(283)。
- **每个 agent preset**（`standard`）**再挂一次** `dsh-skill-filesystem`(84) 与 `dsh-tool-skill`(87)，注册进 **preset 自己的层**。该文件注释原文：

  > The skill REGISTRY lives in the host composition and is layered per scope:
  > these rows register into THIS preset's layer of it, so they need no realm.

**推论（关键）**：读取时「最近层直接赢得重名」，rank 只在**同一层内**比较。因此宿主机层插入的覆盖提供方**会被 preset 层的 filesystem 候选压掉**。覆盖必须注册进调用 agent 的 scope。

### 2.3 技能格式（`dsh-skill-filesystem/README.zh.md`）

- `<root>/<name>/SKILL.md`（目录 bundle）或 `<root>/<name>.md`（平铺）。**只扫一层**，不递归。
- YAML frontmatter：必填 `name`（kebab-case）+ `description`；可选 `whenToUse`、`metadata`、`disable-model-invocation`、`user-invocable`。
- 布尔键接受 `true/false`、`yes/no`、`on/off`、`1/0`（大小写不敏感）；**非法拼写会整条丢弃并告警**。

### 2.4 根目录与 rank（数字小者胜）

| rank | source | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `$DSH_HOME/skills`（跳过其 `.system`） |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills` |
| 600 | `bundled` | `$DSH_BUNDLED_SKILL_DIR` |

`projectRoot` = 含 `.git` 的最近祖先目录。

### 2.5 注册表 API

```ts
ctx.skills.registerProvider(create: (control) => SkillProvider): () => void
ctx.skills.register(skill: SkillRegistration): () => void
ctx.skills.snapshot(options?: { cwd?, scope?, signal? }): Promise<{ skills: SkillSummary[]; complete: boolean }>
ctx.skills.list(options?) / get(name, options?)
ctx.on('skills/change', ...)
```

`SkillCandidate` 携带 `rank`、`locator`、`path`；`SkillSummary` **不含 path**。裁决顺序：层（越近越优先）→ rank → 提供方注册顺序 → 提供方内顺序。

### 2.6 启停机制：**已实测证明可行**

`spike/registry-probe.mjs` 用**真实发布包**离线启动 cordis，挂载真的 `dsh-skill` + `dsh-skill-filesystem`，再挂一个抛出覆盖候选的第三方提供方：

| 场景 | `test-driven-development` 的胜出者 |
|---|---|
| S1 仅文件系统提供方 | `filesystem`，`model=true` |
| S2 覆盖提供方 rank=0 | **`probe-overlay-rank-0`，`model=false`** |
| S3 覆盖提供方 rank=399 | **`probe-overlay-rank-399`，`model=false`** |

⇒ 第三方提供方以更低 rank 发出候选即可覆盖策略，**源文件不动**。S2/S3 都成立，取 rank 0 更稳（低于全部文件系统 rank）。

同时该探针给出基线事实：**宿主层单独看只有 5 个 skill**（`grill-me`、`grilling`、`python-typed-development-skills`… 全为 `user-dsh` / `user-agents`）。

### 2.7 一个未解释的现象（待验证）

已装的 michengai 插件在 `~/.dsh/skills-manager/state.json` 里记了 `grill-me` 启用、`test-driven-development` 停用，其 `<你的实例>/dsh-skills-manager/state` 也自报 `test-driven-development` 的 `effectiveModelInvocable=false`；但本机活动会话的技能目录里**仍列出 `test-driven-development`**，而 `grill-me`（源文件自带 `disable-model-invocation: true`）**确实被翻成了可见**。

一胜一负。最可能的解释是它只在宿主层注册全局提供方，被 preset 层的 filesystem 候选压掉；`grill-me` 的可见另有来源。**结论：不依赖它的行为，我们的实现必须两层注册 + 提供自证路由。**

## 3. 我们的设计

### 3.1 分层

```
lib/            宿主半边（纯 ESM JS，无构建步骤）
  index.js        cordis 插件入口：name / inject / apply
  roots.js        根目录发现、项目根解析、条目扫描
  frontmatter.js  frontmatter 读取与严格校验（零依赖，只读）
  store.js        state.json 读写（原子写）+ 策略模型
  provider.js     覆盖提供方（宿主层 + 每个 agent 作用域各一份）
  routes.js       <你的实例>/dsh-skills-manager/* HTTP 路由
  tools.js        Agent 侧 skills CRUD 工具
client/client.js 浏览器半边（手写懒 CJS 工厂，无打包器）
test/            纯 node 测试
spike/           一次性机制探针
```

无构建步骤是有意选择：宿主半边改动只需重载 profile，没有「改了源码忘了构建」这一类失败模式。

### 3.2 状态与策略

`$DSH_HOME/dsh-skills-manager/state.json`

```json
{ "version": 1, "overrides": { "<rootKey>": { "<skill-name>": { "enabled": true|false } } } }
```

- 只有**显式覆盖**才进 state；未覆盖 = 沿用源文件策略。
- 覆盖通过 provider 候选的 `invocation` 施加，**永不写源文件**。

### 3.3 覆盖提供方（`provider.js`）

- 扫描与 `dsh-skill-filesystem` 相同的根集合，为**每个有覆盖的 skill** 发一个候选。
- `rank: 0`。
- 同时为 bundle 提供 `resourceBase` 与 `locator`，使 `get()` 能把真实正文交给模型。
- 注册两处：
  - 宿主行 `apply()` 里注册一次（全局层）；
  - `ctx.on('agent/created')` + `agents.list()` 遍历，经 `agent.ctx.get('skills').registerProvider(...)` 注册进该 agent 的层 —— 这是突破 preset 层遮蔽的必要条件。
- 变更后调用该注册的 `control.invalidate()`。

### 3.4 自证路由

`GET <你的实例>/dsh-skills-manager/registry` 直接返回 `ctx.skills.snapshot()` 的真实解析结果（名字 / 最终 invocation / 胜出 provider / source）。

这是本项目的验收手段：**启停是否生效不靠插件自称，而由一条 curl 读取注册表真实解析结果判定。**

### 3.5 能力清单（本轮范围）

1. 列表 + 启停（不改源文件）
2. 正文查看与编辑
3. 新建 / 导入（ZIP、文件夹、单个 `SKILL.md`）
4. 删除 + 回收站 + 恢复
5. Agent 侧工具（skills CRUD）

### 3.6 验收标准

1. `node spike/registry-probe.mjs` 三个场景全绿（机制回归）。
2. 单元测试全绿。
3. `dsh plugin --profile web add link:F:/project/dsh-skills-manager` 后重载，`GET /dsh-skills-manager/registry` 返回真实注册表。
4. 停用某 skill 后，同一路由返回该 skill 的 `modelInvocable=false`，且新会话目录不再列出它。
5. 卸载 michengai 后功能不受影响。

## 4. 验证记录

### 4.1 分层遮蔽（`test/layers.test.mjs`，已证）

用 `@deepseek-ai/dsh-scope` 的 `createScope` 复现「宿主层 + preset 层」的组合，挂真实的 `dsh-skill` 与 `dsh-skill-filesystem`：

| 场景 | 结果 |
|---|---|
| 文件系统提供方注册在 preset 层，覆盖只注册在宿主层 | 胜出者仍是 `filesystem`，`modelInvocable` 仍为 `true` —— **停用完全没有生效** |
| 覆盖同时注册进 preset 层 | 胜出者是 `dsh-skills-manager`，`modelInvocable=false` —— 停用生效 |

**结论**：`lib/index.js` 的 `installAgentProviders` 是必需品而非保险。参考实现只注册了宿主层，这解释了 2.7 节的现象。

### 4.2 命名空间冲突（已修）

两处与 `@michengai/dsh-skills-manager` 的**直接冲突**，都会在并存期造成数据损坏或挂载失败：

| 资源 | michengai | 本插件（修正后） |
|---|---|---|
| 状态目录 | `$DSH_HOME/skills-manager/` | `$DSH_HOME/dsh-skills-manager/` |
| 路由前缀 | `/api/dsh-skills-manager` | `/dsh-skills-manager` |

前者会让两边的 `state.json` 互相覆盖；后者会让同前缀的第二次 `webServer.register` 抛错。

### 4.3 客户端依赖（实测）

DSH 的客户端模块表里**没有** `@deepseek-ai/dsh-client-ui-primitives`（npx 树与 profile 树都没有），而参考实现的 `client/client.js` 却在 require 它。本插件的浏览器半边因此只依赖 `react`，样式自带。`test/client.test.mjs` 会在 `node:vm` 里加载 bundle，任何对模块表之外模块的 require 都会让测试失败。

### 4.4 测试现状

```
node --test  →  58 tests, 58 pass, 0 fail
```

覆盖：frontmatter 解析与校验、根目录与扫描、目录聚合与遮蔽、状态存储、ZIP 与 zip-slip、写操作与回收站、插件级端到端（真实注册表 + 真实文件系统）、真实注册表集成、分层遮蔽、客户端 bundle 契约。

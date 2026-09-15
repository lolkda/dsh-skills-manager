# @lolkda/dsh-skills-manager

在 DeepSeek Harness 的 Web 界面里管理 DSH **自己会读取**的技能目录。

它只做一件事，并且把它做透：让「这个技能现在到底会不会被加载」这个问题有唯一、可验证的答案。

- **列表** —— 按 DSH 的真实根目录顺序列出技能，标明来源、rank、重名遮蔽关系。
- **启停** —— 改变 DSH 里的调用策略，**不改动源文件**。随时可撤销。
- **正文查看与编辑** —— 直接读写 `SKILL.md`，带 frontmatter 诊断。
- **新建 / 导入** —— 目录 bundle、平铺 `.md`、ZIP 包。
- **删除 / 回收站 / 恢复**。
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

- `scope: "host"` —— 没有任何活动会话，读到的是宿主层。**真实部署里宿主层通常一条技能都没有**：技能由 preset 层提供，而 `dsh-skill` 的候选来自 `[layers.global, ...chainLayers(scope)]`，不带 scope 只看到 global。
- `scope: "agent"` —— 有会话，`skills` 是该 agent 所在层链的合并结果，也就是模型真正看到的那一份。`host` 字段仍然给出宿主层视图供对照。

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
node --test                      # 62 个测试：单元 + 真实注册表集成 + 分层遮蔽 + 客户端契约
node spike/registry-probe.mjs    # 一次性机制探针：打印三个场景下的胜出者
```

改动宿主半边后需要重载 profile 才生效：

```powershell
dsh plugin --profile web add link:F:/project/dsh-skills-manager
```

工程约定与已实测的机制细节见 `research/DESIGN.md`，真机验收证据见 `research/ACCEPTANCE.md`。

## 许可

MIT

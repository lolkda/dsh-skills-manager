# dsh-skills-manager 本机审查报告

## 结论

**有本机测试，但现有测试全绿不能证明这个插件正确。截图中的漏技能已在当前 3080 实例复现；还存在实际文件损坏、越过只读限制、策略持久化失败和界面状态错误。**

- 审查基线：Git `4d5f583`，插件 `0.1.0`；Windows，Node `v24.18.0`，npm `11.16.0`。
- 实测时间：2026-09-19 UTC（以机器当前运行时间为准，不沿用环境快照日期）。
- 本机 DSH filesystem 包：`0.1.6-alpha.1`，见 [package.json:1–4](F:/project/dsh-skills-manager/node_modules/@deepseek-ai/dsh-skill-filesystem/package.json#L1-L4)。结论针对这个实际依赖版本；未声称验证了兼容区间内的全部历史版本。
- 原有 `npm test`：**126 pass / 0 fail**。
- 收尾 `npm run check`：**126 pass / 0 fail**，包含客户端语法检查。
- 新增独立审查用例：**24 条，1 条正常对照通过，23 条缺陷验收断言失败**；连续两次全新隔离运行结果一致，**0 skip**。
- 23 条失败场景不等于 23 个独立安全漏洞；有些覆盖同一类根因。以下区分 P1（优先修复的数据/权限/核心功能问题）与 P2（后续修复的状态/交互问题）。
- **没有修改生产实现、真实技能文件或真实启停配置，没有安装依赖、启动替代 DSH 服务器或重启 3080。** 本次新增内容仅位于工作区审查目录与单独的临时可视化报告。

## 一、截图里少的两条到底去哪了？

对现有 `http://127.0.0.1:3080`，以截图中的 `F:\project\dsh-model` 为 `cwd` 发出只读 GET：

| 观测 | 实际结果 |
|---|---|
| `/catalog` 根目录 | project-dsh、project-agents、user-dsh、user-agents，**没有 custom 根** |
| `/catalog` 技能数 | 7（用户 DSH 根 6、agents 根 1） |
| `/registry` 技能数 | 9 |
| 额外两条 | `cordis-plugin-development`、`editing-cordis-compositions` |
| 两条的来源 | `provider=filesystem`、`source=custom` |
| 对比结论 | `ours=7, registry=9, extra=[上述两条]` |

证据：[runtime-evidence.json:13–44](F:/project/dsh-skills-manager/audit/runtime-evidence.json#L13-L44)、[runtime-evidence.json:118–129](F:/project/dsh-skills-manager/audit/runtime-evidence.json#L118-L129)、[runtime-evidence.json:174–186](F:/project/dsh-skills-manager/audit/runtime-evidence.json#L174-L186)。

**根因不是截图样式，也不是 `.system` 被隐藏。** 已安装的 Cordis preset 在 [agent.cordis.yml:256–267](F:/project/dsh-skills-manager/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml#L256-L267) 给自己的 filesystem 提供方设置了 preset 内的 `skills/` 作为 `customSkillDirs`；插件的 [roots.js:129–138](F:/project/dsh-skills-manager/lib/roots.js#L129-L138) 只读取**插件自己的**这份配置。

隔离测试 `R20` 用真正的 `FileSystemSkillProvider` 读取这个已安装 preset，也得到同样两条；插件默认目录却没有它们。这是**实际部署的两份配置脱节**，不是浏览器缓存猜测。仅调整红色提示文案解决不了技能缺失。

短期可显式同步根配置；长期建议把当前 scope 的真实目录作为权威来源，至少展示只存在于注册表中的条目并说明其可管理能力，而不是继续要求两份配置永久人工一致。

## 二、按优先级排列的已验证问题

### P1：权限、文件完整性和核心行为

| 用例 | 问题与可观察后果 | 代码位置 |
|---|---|---|
| R01 | **Host 被当作鉴权。** 没有 cookie/token 的现有实例请求：首页与 `/api` 都是 401，而插件 `/catalog`、`/registry` 是 200。同样只带 Host 的临时路由调用能实际创建文件。能到达该监听端口的未认证调用者不应因此获得技能写权限。 | [routes.js:128–147](F:/project/dsh-skills-manager/lib/routes.js#L128-L147)、[routes.js:416–430](F:/project/dsh-skills-manager/lib/routes.js#L416-L430) |
| R02 | **HTTP 保存绕过只读根。** `bundled` 已被标成 `mutable:false`，但直接调用保存端点仍返回成功，并改写临时 bundled 文档；禁用前端按钮不是后端限制。 | [routes.js:171–175](F:/project/dsh-skills-manager/lib/routes.js#L171-L175)、[operations.js:86–96](F:/project/dsh-skills-manager/lib/operations.js#L86-L96) |
| R19 | **文件符号链接可把保存带出技能根。** `within()` 只检查字符串前缀；临时技能文档指向同一测试沙箱内、技能根外的文件时，保存会改动那个外部目标。 | [operations.js:43–47](F:/project/dsh-skills-manager/lib/operations.js#L43-L47)、[operations.js:86–95](F:/project/dsh-skills-manager/lib/operations.js#L86-L95)、[roots.js:198–200](F:/project/dsh-skills-manager/lib/roots.js#L198-L200) |
| R07 | **覆盖导入失败已毁掉旧包。** 有效 ZIP 内先有普通文件 `collision`，再有 `collision/child.txt`；第二步写入失败，HTTP 返回失败，但旧文档及旧附件已被删除，磁盘留下半个新包。 | [operations.js:154–168](F:/project/dsh-skills-manager/lib/operations.js#L154-L168) |
| R17 | **导入成功但写入的不是校验过的主文档。** ZIP 包含 `alpha/SKILL.md`（合法）及 `bravo/SKILL.md`（非法）；对每个路径盲目截掉 `alpha/` 的长度，后者最终覆盖前者。响应 `ok:true`，落地技能却不可加载。 | [operations.js:146–170](F:/project/dsh-skills-manager/lib/operations.js#L146-L170) |
| R18 | **Windows NTFS 数据流别名绕过 ZIP 文件名校验。** `SKILL.md::$DATA` 被放行，实际写到默认数据流，覆盖已校验的主文档；在本机 NTFS 上实测成功，导入仍报成功。 | [zip.js:116–130](F:/project/dsh-skills-manager/lib/zip.js#L116-L130)、[operations.js:161–168](F:/project/dsh-skills-manager/lib/operations.js#L161-L168) |
| R05 | **写盘失败污染内存，重试假成功。** 状态目录被普通文件占用时设置失败；移除障碍后重试返回 `ok:true, changed:false`，状态文件却从未创建。内存先更新，持久化失败没有回滚。 | [index.js:132–138](F:/project/dsh-skills-manager/lib/index.js#L132-L138)、[index.js:157–161](F:/project/dsh-skills-manager/lib/index.js#L157-L161) |
| R06 | **共用 DSH_HOME 的两个实例互相丢设置。** 两个 runtime 同时从空状态启动，A 停用 alpha，B 停用 beta，两次都成功，最终磁盘只有 beta。原子 rename 只能避免半个文件，不能防止陈旧快照覆盖。 | [index.js:81–90](F:/project/dsh-skills-manager/lib/index.js#L81-L90)、[store.js:124–135](F:/project/dsh-skills-manager/lib/store.js#L124-L135) |
| R11 / R12 | **手写 YAML 解析器与当前 DSH 不一致。** 合法 `disable-model-invocation: "true"` 被插件拒绝，真实 DSH 接受；重复 `name` 键被插件接受，真实 DSH 丢弃。这同时破坏“发现是否准确”和“保存后一定可加载”两项保证。 | [frontmatter.js:68–74](F:/project/dsh-skills-manager/lib/frontmatter.js#L68-L74)、[frontmatter.js:133–180](F:/project/dsh-skills-manager/lib/frontmatter.js#L133-L180) |
| R21 | **启用覆盖会改变模型实际收到的正文。** 合法块标量中有缩进的 `---`，插件先 trim 再判断分隔符，误把 frontmatter 中段当结束；真实 `registry.get()` 的正文从 `body` 变成 `second\n---\nbody`。没有改磁盘，也仍然改变了实际加载内容。 | [frontmatter.js:113–118](F:/project/dsh-skills-manager/lib/frontmatter.js#L113-L118)、[provider.js:130–134](F:/project/dsh-skills-manager/lib/provider.js#L130-L134) |
| R20 | **截图中的 preset 技能漏扫。** 原生提供方的 custom 根与插件根没有统一来源，两条真实存在的技能无法在列表中管理。 | [roots.js:129–138](F:/project/dsh-skills-manager/lib/roots.js#L129-L138)、[Cordis preset:263–267](F:/project/dsh-skills-manager/node_modules/@deepseek-ai/dsh-agent-presets/presets/cordis/agent.cordis.yml#L263-L267) |

R01 的范围限定：本次已证明未认证本地 HTTP 读取、以及同一真实处理函数接受无凭据写入；**未进行跨站网页利用或远端网络攻击**。跨站浏览器是否可达还受部署绑定地址、代理和浏览器策略影响。修复需要接入 DSH 的实际认证机制；仅加一条 Host 白名单不等于认证。

R19 的测试仅修改自己创建的临时目标，没有访问或改动用户其它文件。修复需要明确符号链接策略和实际路径验证，不能把 `resolve()` 当成 `realpath()`；也应考虑检查与打开之间的竞态。

### P2：管理入口、作用域和界面可靠性

| 用例 | 问题与可观察后果 | 代码位置 |
|---|---|---|
| R03 | **中文或带空格项目的写操作失败。** 目录接口自己生成带完整路径的 rootKey，却又只允许 ASCII 无空格字符；直接把服务端给的 key 传回创建端点就得到 `root.invalid`。保存、删除、导入也经过同一校验；并非所有读取/启停都失败。 | [roots.js:109–113](F:/project/dsh-skills-manager/lib/roots.js#L109-L113)、[roots.js:221–225](F:/project/dsh-skills-manager/lib/roots.js#L221-L225)、[routes.js:357–361](F:/project/dsh-skills-manager/lib/routes.js#L357-L361) |
| R04 | **损坏技能能列出，却不能读取修复。** `winners` 排除了不可加载文档，管理读取又只查 winners，导致确实存在的损坏文件返回 `skill.unknown`。界面还把所有非 winner 归入“被同名技能遮蔽”，点击无详情。 | [catalog.js:78–86](F:/project/dsh-skills-manager/lib/catalog.js#L78-L86)、[routes.js:373–382](F:/project/dsh-skills-manager/lib/routes.js#L373-L382)、[client.js:719–733](F:/project/dsh-skills-manager/client/client.js#L719-L733) |
| R08 | **注册表核对的是第一个 agent，不是所选项目。** 请求 `?cwd=B`，存在 A/B 两个 agent 时，响应的核对目录和技能仍取 A。界面把 B 的列表与 A 的核对结论放在一起。 | [routes.js:304–324](F:/project/dsh-skills-manager/lib/routes.js#L304-L324) |
| R13 | **“一致”只校验名字。** 插件显示停用、注册表实际启用，只要名称相同，`consistent` 仍是 true。它不能支撑界面“真实裁决结果”的措辞；应比较策略/来源/完整性，或把文案严格限为名称集合一致。 | [divergence.js:66–81](F:/project/dsh-skills-manager/lib/divergence.js#L66-L81)、[client.js:493–505](F:/project/dsh-skills-manager/client/client.js#L493-L505)、[client.js:745–747](F:/project/dsh-skills-manager/client/client.js#L745-L747) |
| R14 | **custom 根调整顺序会把覆盖移给另一个目录。** key 是 `custom-0` 这样的数组下标；A/B 调换后，B 下的同名技能继承之前给 A 设置的停用。 | [roots.js:129–137](F:/project/dsh-skills-manager/lib/roots.js#L129-L137)、[catalog.js:204–207](F:/project/dsh-skills-manager/lib/catalog.js#L204-L207) |
| R15 | **新建不检查平铺文件的同名技能。** 已有 `dup.md`，再创建 dup 仍成功，新增 bundle 遮蔽原文件。物理目录是否存在不等于逻辑技能名是否重复。 | [operations.js:59–74](F:/project/dsh-skills-manager/lib/operations.js#L59-L74) |
| R09 | **切换项目后沿用旧项目过滤器，列表变空。** 先选 project-dsh，再从 A 换 B；filter 中仍是 A 的 rootKey，B 有技能也显示“这个范围内没有技能”。 | [client.js:555–559](F:/project/dsh-skills-manager/client/client.js#L555-L559)、[client.js:595–599](F:/project/dsh-skills-manager/client/client.js#L595-L599) |
| R10 | **启停失败提示被立刻清掉。** POST 失败后设置错误，随后无条件 reload；GET 成功又 `setError(null)`，用户只看到开关没有变化。删除分支有同样的先报错再 reload 结构。 | [client.js:536–540](F:/project/dsh-skills-manager/client/client.js#L536-L540)、[client.js:567–575](F:/project/dsh-skills-manager/client/client.js#L567-L575)、[client.js:707–712](F:/project/dsh-skills-manager/client/client.js#L707-L712) |
| R16 | **导入文件读取失败会永久 busy。** `file.text()` / FileReader 的等待在 request 的 catch 之外；读取失败跳过复位逻辑，上传及取消按钮一直禁用。 | [client.js:345–358](F:/project/dsh-skills-manager/client/client.js#L345-L358)、[client.js:378–386](F:/project/dsh-skills-manager/client/client.js#L378-L386) |
| R22 | **启用覆盖会丢掉原 metadata。** 原生 `get()` 返回的嵌套 metadata，在仅设置 `enabled:true` 后变成 undefined；注册表不继承落选提供方的字段。它是字段保真缺陷，未断言当前 DSH UI 已依赖该字段。 | [provider.js:76–86](F:/project/dsh-skills-manager/lib/provider.js#L76-L86)、[provider.js:96–117](F:/project/dsh-skills-manager/lib/provider.js#L96-L117) |
| R23 | **同根同名 bundle/flat 裁决不一致，点开关换了另一份技能。** 原生按完整目录项名排序，插件先剥扩展名；`a-b/SKILL.md` 与 `a.md` 都声明同名时，真实 `get()` 在启用覆盖后由 BUNDLE 变为 FLAT。 | [roots.js:204–208](F:/project/dsh-skills-manager/lib/roots.js#L204-L208)、[catalog.js:216–218](F:/project/dsh-skills-manager/lib/catalog.js#L216-L218) |

## 三、本机测试到底测到了什么？

### 本次实际运行

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm test` | 126 pass / 0 fail | [首次全量日志:131–138](C:/Users/Administrator/.fastctx/jobs/j-td5y61/output.log#L131-L138) |
| `npm run check` | 126 pass / 0 fail | [baseline-check.log:131–138](F:/project/dsh-skills-manager/audit/baseline-check.log#L131-L138) |
| `node --test audit/regressions.mjs`，第一轮 | 1 pass / 23 fail / 0 skip | [regression-run-1.log:1–32](F:/project/dsh-skills-manager/audit/regression-run-1.log#L1-L32) |
| 同一命令，第二轮全新夹具 | 1 pass / 23 fail / 0 skip | [regression-run-2.log:1–32](F:/project/dsh-skills-manager/audit/regression-run-2.log#L1-L32) |
| 对 3080 的只读目录/注册表请求 | 复现 7 对 9、两条 preset 技能缺失 | [runtime-evidence.json](F:/project/dsh-skills-manager/audit/runtime-evidence.json) |

这些失败均已检查为 **`AssertionError` 表示预期行为未满足**，不是导入失败、语法错误或测试环境崩溃。正常创建与策略持久化对照用例通过。失败测试特意保留为后续修复的验收规格，本轮没有把断言改成接受现有错误行为。

### 为什么原有 126 条抓不到？

1. **一部分测试固化了错误预期。** 例如 [frontmatter.test.mjs:50–56](F:/project/dsh-skills-manager/test/frontmatter.test.mjs#L50-L56) 的布尔测试，测试运行名称明确要求拒绝带引号布尔值；本机原生提供方实际上接受。单测不是天然的真实行为依据。
2. **前端使用迷你 Hooks 渲染器，而不是实际浏览器。** [client-harness.mjs:18–69](F:/project/dsh-skills-manager/test/helpers/client-harness.mjs#L18-L69) 对 React 做了替身；现有用例只检查切换后的 URL，没有检查选择 project 根过滤器后再切换目录的结果。
3. **损坏文档仅断言“显示不可加载、开关禁用”。** 没有走“读取 → 修复 → 保存”的完整管理路径，见 [client-render.test.mjs:173–191](F:/project/dsh-skills-manager/test/client-render.test.mjs#L173-L191)。
4. **默认临时夹具使用 ASCII 路径、可写根、简单 ZIP、单 runtime。** 没覆盖非 ASCII 根 key、bundled 保存、真实写入中途失败、同一状态文件多实例更新、NTFS 数据流别名。
5. **浏览器探针不在默认 test/check 中。** 入口定义见 [package.json:23–31](F:/project/dsh-skills-manager/package.json#L23-L31)。此外 [browser-probe.mjs:734–737](F:/project/dsh-skills-manager/spike/browser-probe.mjs#L734-L737) 找不到浏览器时退出 0；[browser-probe.mjs:210–211](F:/project/dsh-skills-manager/spike/browser-probe.mjs#L210-L211) 含永远成功的 `check(zipOk || true, ...)`。探针的退出码不能单独充当完整 UI 验收证据。
6. Node 报的 126 还包括两个测试 helper 文件入口，见 [首次全量日志:62–63](C:/Users/Administrator/.fastctx/jobs/j-td5y61/output.log#L62-L63)。应关注断言覆盖，而不是只看数量。

### 验证边界

- 新增测试执行真实生产函数、真实临时磁盘；HTTP 用真实捕获 handler 驱动，不监听新端口。
- R08 使用真正的技能注册表，R11/R12/R20 使用本机真正的 DSH filesystem 提供方；R21/R22/R23 还通过真实 `registry.get()` 比较覆盖前后的正文、metadata 和内容来源。
- R09/R10/R16 是仓库已有迷你 Hooks 运行器中的交互验证，**不冒充 Chrome/React DOM 端到端测试**；R10 的网络失败用 fetch adapter 注入，以可重复地触发错误分支。
- **本次没有跑完整已认证浏览器 E2E。** 现有 3080 首页裸请求 401；没有去读取未提供的认证令牌或运行会修改真实技能的探针参数，也没有为此另起一个服务器。
- 没有覆盖所有 DSH 版本、所有 preset、断电/磁盘满压力场景与所有 ZIP 格式；没有做大内存或 DoS 测试。

## 四、复现与交付

在项目根运行：

```powershell
# 原有验证（本次仍通过）
npm test
npm run check

# 独立审查规格：当前版本预期返回 exit code 1
node --test audit/regressions.mjs

# 只看一条，比如覆盖导入损坏原文件
node --test --test-name-pattern="R07:" audit/regressions.mjs

# 只读重查现有实例；不发送修改请求
node audit/runtime-check.mjs http://127.0.0.1:3080 "F:\project\dsh-model"
```

- [regressions.mjs](F:/project/dsh-skills-manager/audit/regressions.mjs)：全部隔离复现。文件名刻意不进入默认 `node --test` 的自动发现，避免一次审查擅自改变默认测试集；修复时应逐条迁入正式测试。
- [runtime-check.mjs](F:/project/dsh-skills-manager/audit/runtime-check.mjs)：只读运行证据采集，不采集正文、cookie 或 token；现有实例的状态会随会话变化。
- [runtime-evidence.json](F:/project/dsh-skills-manager/audit/runtime-evidence.json)：本轮运行快照。
- [baseline-check.log](F:/project/dsh-skills-manager/audit/baseline-check.log)、[regression-run-1.log](F:/project/dsh-skills-manager/audit/regression-run-1.log)、[regression-run-2.log](F:/project/dsh-skills-manager/audit/regression-run-2.log)：完整输出。

复现依赖当前安装的 DSH/cordis 包及已安装 preset；没有声称它在没有依赖的空 checkout 内即可直接运行。R18 为 Windows NTFS 场景，其他系统会明确 skip；R19 在 OS 不允许创建符号链接时会明确 skip，本机两轮均未跳过。

## 五、建议怎么修，而不是继续补文案

### 1. 先保证写入可信且可回滚（Strong）

将鉴权、只读判定、真实路径约束、名字冲突、预验证、暂存、提交/回滚收进一个 **skill mutation module**。HTTP 与 Agent tools 是两个真实的 **adapter**，经同一 **interface** 进入该 module；不要让约束散落在各个入口，形成跨 **seam** 的泄漏。策略落盘成功前不要发布内存新状态，多实例必须有锁/版本协调或单一写入者。

- **locality**：一次修复覆盖 HTTP 与工具路径，而不是一边拒绝另一边放行。
- **leverage**：同一组故障注入测试验证所有调用入口。
- **deletion test**：删去入口里重复的业务判断，应把复杂性集中到可测试的提交逻辑，而不是搬到另一个薄转发层。

### 2. 统一技能解析与当前 scope 的权威目录（Strong，推荐结构性调整）

**推荐停止维护平行的 YAML 子集与“等价目录”推导，改为复用 DSH 的解析语义和 scope 目录。** 这是可能改变内部结构及现有测试假设的调整，但比继续增加字符串特判可靠。把可加载目录与“磁盘上存在但损坏、可修复的文档”区分开；后者不能因为不是 winner 就失去管理入口。稳定身份不应使用数组下标。

- 建立有足够 **depth** 的 skill catalog **module**；其 **implementation** 吸收 preset 根解析、同名裁决与诊断，而不是要求每个调用者理解两份配置。
- 文件系统和当前 DSH 注册表是实际存在的两个 **adapter**，由 **seam** 隔离版本差异。
- **locality**：名称、来源、策略与正文指向同一条记录。
- **leverage**：对真实 DSH 做契约测试，旧有错误单测不能继续充当 oracle。

### 3. 让界面状态按项目和操作归属（Worth exploring）

目录、过滤器、编辑状态及在途请求应属于同一 cwd；换目录时重置不再有效的 root 过滤器，丢弃旧请求结果。加载错误与写操作错误分开保存；所有 busy 操作用 `try/finally` 收尾。用真实浏览器测试验证这一 **interface**，不要再扩写一个越来越像 React 的测试替身。

**建议修复顺序：写入安全与数据完整性 → 截图漏项/解析语义 → scope 与界面状态。** 本报告止于审查与可重复验证，未实施这些结构性修改。

这三个方向的前后结构对照见 [可视化审查报告](D:/Personal/Temp/dsh-GKgoJW/architecture-review-20260919-203615.html)。

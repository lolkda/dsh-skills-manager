# 本轮修复范围与暂缓项

## 用户确认的顺序

1. 先修上一轮摘要中的 P1：
   - 覆盖导入失败不能删除或改坏原包（R07）。
   - 策略写盘失败不能提前发布内存状态，重试必须真正保存（R05）。
   - 保存必须遵守只读根限制，不能经符号链接写到技能根外（R02 / R19）。
2. 再处理审查报告的 P2：合法项目路径、损坏技能管理、注册表 scope、核对语义、自定义根稳定身份、重名创建、前端过滤/错误/busy 状态，以及非正文的覆盖字段保真。
3. 没有得到单独授权的其它 P1 不自动扩大为本轮任务；如果修复共享写入路径同时消除相关缺陷，会在完成记录中单列说明。

历史审查基线与全部用例见 [审查报告](F:/project/dsh-skills-manager/audit/REVIEW.md) 和 [隔离验收规格](F:/project/dsh-skills-manager/audit/regressions.mjs)。历史报告的测试结果与代码行号属于审查时点，不作为修复后状态。

## 明确暂缓：R21，启停覆盖时正文解析改变

**状态：按用户要求暂缓，保留现有行为，本轮不修改这一处分隔符/正文解析逻辑。**

用户要求的“关闭后立即生效”必须保留。审查指出的 R21 是另一件事：合法 YAML 块标量中包含缩进的 `---` 时，插件把它误当 frontmatter 结束符，使模型读到的正文由 `body` 变为 `second\n---\nbody`。这个问题不是指启停是否即时生效，也不是源文件被开关改写。

最小输入：

```markdown
---
name: demo
description: |
  first
  ---
  second
---
body
```

- 原生 DSH 的正文：`body`。
- 当前启用覆盖后的正文：`second\n---\nbody`。
- 涉及实现：[frontmatter.js](F:/project/dsh-skills-manager/lib/frontmatter.js)、[provider.js](F:/project/dsh-skills-manager/lib/provider.js)。
- 复查命令：`node --test --test-name-pattern="R21:" audit/regressions.mjs`。
- 后续仅在用户确认后修复；保留这个反例，不通过改弱断言或静默跳过把它假装成通过。

## 验收约定

- 每组先运行失败测试，再修改实现，并运行相关测试与全量 `npm run check`。
- 将本轮已修场景纳入默认测试，而非仅留在独立审查目录。
- 全部写入验证使用新的临时数据，不修改真实技能/启停配置。
- 不未经确认重启现有 DSH 实例；源码测试通过与正在运行的实例已加载新代码是两个不同结论。

## 修复阶段记录

### P1 第一轮

- 正式回归从 6 条失败、1 条通过变为 7 条全部通过。
- 相关测试 46/46 通过，全量 `npm run check` 当时为 133/133 通过。
- `writeSkillContent` 的内部契约改为接收完整 `root`，不再只传 `rootPath`；HTTP、工具、测试和本地修复脚本调用处均已适配。
- 导入在同一卷的独立暂存目录构建完整包，提交失败恢复旧包；恢复也失败时保留并返回 `recoveryPath`，不能在清理时删除仅剩的备份。
- 设置与清除覆盖都先落盘再发布内存并立即失效注册表。
- 额外安全复核发现硬链接也会共享文件内容；已补失败用例，并改为文档同目录暂存后原子替换，不再截断共享 inode。硬链接、符号链接和目录链接的正式测试均通过。提交失败恢复、恢复失败保留恢复副本也已加入正式故障注入测试。

### P2 的兼容性决定

- `custom-N` 位置键已改为包含路径身份的 `custom@...`。旧状态没有记录历史路径，无法可靠自动迁移；不按当前数组顺序猜测，以免把停用策略施加到另一目录。旧项保留并显示警告，由用户确认后重设。
- HTTP 读取、编辑、删除可带目录返回的 `docPath`，但必须在当前根和目录记录中精确查表。它不是接受任意外部文件路径的接口。
- 损坏/遮蔽的文档可管理；启停策略仍只作用于实际胜出条目。
- 目录加载与编辑请求绑定项目和请求版本，拒绝旧响应覆盖新选择；失败消息不能被成功的 GET 抹掉。
- R21 的分隔符和正文处理仍按用户要求不改。

## 最终验收

- **本轮选定范围已完成**：R02、R03、R04、R05、R07、R08、R09、R10、R13、R14、R15、R16、R19、R22、R23；导入安全改造同时消除了 R17、R18。
- `npm run check`：**168/168 通过，0 失败，0 跳过**，包含客户端语法检查、真实 DSH 注册表测试、前后端与临时磁盘集成、链接边界和提交/回滚故障注入。见 [最终测试日志](F:/project/dsh-skills-manager/audit/fix-final-check.log#L173-L180)。
- 完整历史审查规格：**18 通过、6 失败**。失败项保持明确可见，没有弱化或跳过断言：R21 是用户明确暂缓；R01（鉴权）、R06（多实例状态）、R11/R12（完整 YAML 语义）、R20（preset 根漏项）是完整报告中未列入本次所选四组摘要 P1 的其它 P1，仍待另行排期。见 [审查规格复跑](F:/project/dsh-skills-manager/audit/fix-final-audit.log#L1-L32)。
- 这意味着：**截图中的两条 preset 技能漏项本轮尚未修复**。本轮“完成”不表示整个历史审查列表全部清零。
- `git diff --check` 通过；Git 仅提示现有 `core.autocrlf` 下的 LF/CRLF 转换，无差异格式错误。
- 未修改真实用户技能/启停配置，未重启现有 3080 实例，也未运行完整已认证浏览器 E2E。源码通过测试与正在运行的实例加载新代码是两件事；部署时需要重载宿主插件并刷新浏览器。

### 兼容性与复跑

- 自定义根已使用稳定 `custom@<pathIdentity>` 键；旧 `custom-N` 状态保留并显示警告，不猜测迁移。请确认原目录后重新设置这些旧覆盖。
- 新增了对 `yaml` 的直接运行依赖，本机已有该依赖，未额外安装包；新安装环境按包清单安装依赖。
- 内部保存函数现需完整 `root` 对象；包内 HTTP、工具、测试及修复脚本调用点均已同步。
- 重跑正式验收：`npm run check`。
- 单独观察暂缓项：`node --test --test-name-pattern="R21:" audit/regressions.mjs`，当前仍应以正文差异断言失败。

## 发布与部署记录（0.2.0）

- 提交 `6c1e1f0` 已推送到 `origin/master`（GitHub: lolkda/dsh-skills-manager），标签 `v0.2.0` 已推送。
- npm 已发布 `@lolkda/dsh-skills-manager@0.2.0`（`latest`），18 个文件、71.2 kB；发布日志见 [npm-publish.log](F:/project/dsh-skills-manager/audit/npm-publish.log)。包内容由 `files` 白名单限制，`audit/`、`test/`、`docs/`、`spike/` 均不进入 npm 包。
- 0.2.0 相对 0.1.0 新增直接依赖 `yaml@^2.4.2`（metadata 保真用）。安装方必须让它一起装上，否则插件在启动期解析 `import 'yaml'` 就会失败。

### 升级过程中的一次事故（已修复）

`dsh plugin --profile web add @lolkda/dsh-skills-manager@latest` 在**运行中的实例**上执行失败：

```
ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR
Failed to remove modules directory contents: 拒绝访问。 (os error 5)
```

原因是 pnpm 判定现有 `node_modules` 不可接管，于是先清空再安装，而运行中的 DSH 进程锁住了已加载插件的文件，删除到一半即中止。结果是 profile 的 `node_modules` 被删掉了 `@lolkda/*`（三个）、`@deepseek-ai/cosmokit`、`@deepseek-ai/schemastery`、`@standard-schema/spec`、`argparse`，只剩被锁住的 `dshmarket`、`js-yaml`、`undici` 与三个 link 符号链接。运行中的实例因为代码已在内存里，表面上仍正常响应。

修复方式：在一个独立暂存目录里按 lockfile 的精确版本重新解析，再把缺的包原样拷回 profile，未触碰被锁文件：

- 补回版本：`@deepseek-ai/cosmokit@1.8.3`、`@deepseek-ai/schemastery@3.18.2`、`@lolkda/dsh-prompt-manager@3.2.2`、`@lolkda/dsh-skills-manager@0.2.0`、`@lolkda/dsh-web-lan@0.1.0`、`@standard-schema/spec@1.1.0`、`argparse@2.0.1`、`yaml@2.9.1`。
- profile 的 `package.json` 依赖范围更新为 `^0.2.0`，`pnpm-workspace.yaml` 补 `minimumReleaseAgeExclude` 的 0.2.0 条目。
- `pnpm install --lockfile-only` 重新生成 `pnpm-lock.yaml`（只写 lockfile，不动 `node_modules`），其 `integrity` 与本次发布的 tarball 完全一致：`sha512-n5RZVlcjtWmLXtJXq3Im0bfUkdvWcJChwJIR8KpoJ5MclSlEmHLPqbY/QkpvMOdEe/OtnpG5XHej/xbWP7Kspw==`。
- 校验：profile 根下逐个 `import()` 七个包全部成功；`dsh --profile web --dump-config` 退出码 0，所有 bundle 与插件都能解析。
- 修改前的三个清单文件备份在 `D:/Personal/Temp/dsh-profile-web-manifest-backup-20260920-161632/`。

**结论：`dsh plugin` 的安装/升级必须在实例停止时执行**；运行中升级会先清空 `node_modules` 再失败。

### 生效方式

`dsh` 没有热重载命令，插件升级要重启 profile 进程才生效。当前 3080 上仍是内存中的 0.1.0 宿主代码（界面可用，但看不到本轮修复）。重启步骤：

```powershell
# 1. 结束当前实例（PID 55324 是本次观测到的监听进程，重启前请重新确认）
Get-Process -Id 55324 | Stop-Process
# 2. 重新启动 profile
dsh web
```

重启前建议先在实例停止状态下确认依赖完整（此命令只读，不修改 `node_modules`）：

```powershell
dsh plugin --profile web list
```



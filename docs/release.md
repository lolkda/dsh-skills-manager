# 发布到 npm

本仓库的发布只有一条路：**推 tag → GitHub Actions 打包并发布**。没有任何一步需要在本机跑 `npm publish`。

当前状态：npm 上是 `0.2.0`（`latest`，2026-09-20 发布），仓库里已经走到 `0.2.2-rc.1` 但**尚未发布**。

## 涉及的文件

| 文件 | 作用 |
|---|---|
| [`.github/workflows/publish.yml`](../.github/workflows/publish.yml) | 校验 → 打包 → 发布，只有推 `v*` tag 或手动触发才跑 |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | 分支 / PR 上的测试门禁（不发布，不需要任何 secret） |
| [`scripts/release-plan.mjs`](../scripts/release-plan.mjs) | 由 `package.json` 版本号算出 git tag 与 npm dist-tag，并拦住两类事故 |
| [`test/release-plan.test.mjs`](../test/release-plan.test.mjs) | 上面那段判定的测试，含 CLI 行为 |

`scripts/release-plan.mjs` 是 CI 专用工具，**不进 npm 包**（`package.json` 的 `files` 里有 `!scripts/release-plan.mjs` 把它排除掉）。

## 一次性配置：在 npmjs.com 上登记 Trusted Publisher

认证走 **OIDC（npm Trusted Publishing）**，不需要任何长期 token、也不需要 GitHub secret：

1. 打开 `https://www.npmjs.com/package/@lolkda/dsh-skills-manager` → **Settings** → **Trusted Publisher** → 选 **GitHub Actions**。
2. 填三项，必须逐字一致：
   - Organization or user：`lolkda`
   - Repository：`dsh-skills-manager`
   - Workflow filename：`publish.yml`（文件名，不是路径；`workflow_ref` 里带的是 `.github/workflows/publish.yml`，npm 拿名字比对）
   - **Environment 留空** —— publish job 没有 `environment:`，若在 npm 侧填了环境名，OIDC 声明的 environment 与配置对不上，交换会被拒。
3. 保存。之后 publish job 里 `npm publish` 会自动拿 GitHub 的 id_token 去 `POST /-/npm/v1/oidc/token/exchange/package/<包名>` 换一个**包级短时 token**（npm 的实现见其 `lib/utils/oidc.js`，交换发生在鉴权检查之前）。同一个 id_token 也被 sigstore 用来签 provenance，所以 `--provenance` 走的是同一条通路。

硬性前提：**npm >= 11.5.1**。Node 24 自带 npm 11 ✓；Node 22 自带 npm 10，不认识 OIDC 交换，会静默回退到（本例中不存在的）token。workflow 里「确认 OIDC 通路」这一步就是拿这条守门的。

想先用 token 兜底（不推荐，会引入长期凭据）：仓库 Settings → Secrets 加 `NPM_TOKEN`，再给 publish 那步加回 `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`。npm 的优先级是 OIDC 优先、失败才静默回退到 token —— 正因如此本仓库**故意不配** token，免得回退把配置错误藏起来。

想要「发布前必须人工点一下同意」：先在 Settings → Environments 里**建好**名为 `npm` 的环境并配上 required reviewers，再给 publish job 加 `environment: npm`，**并且在 npm 侧的 Trusted Publisher 里把 Environment 填上同一个名字**。顺序不能反 —— 直接引用一个不存在的环境时 Actions 会隐式创建它，而隐式创建有已知的「job 概率性不启动」问题（[actions/runner#1190](https://github.com/actions/runner/issues/1190)）。

## 发布一个版本

```bash
# 1. 提升版本号并写 CHANGELOG
npm version 0.2.2-rc.2 --no-git-tag-version   # 或手改 package.json
# 编辑 CHANGELOG.md

# 2. 本地先跑一遍 CI 同款检查
npm ci && npm run check

# 3. 提交并打 tag —— tag 必须是 v<package.json 版本>
git commit -am "release: 0.2.2-rc.2"
git tag v0.2.2-rc.2
git push origin HEAD --follow-tags
```

推 tag 之后 `publish.yml` 自动跑。**tag 名与 `package.json` 版本不一致会直接失败**，不会发出任何东西 —— 这一步由 `scripts/release-plan.mjs` 判定，本地也能先自测：

```bash
node scripts/release-plan.mjs --version "$(node -p "require('./package.json').version")" --ref refs/tags/v0.2.2
```

## workflow 到底做了什么

**verify job**（跑测试的 job，无凭据、无 id-token）：

1. `actions/checkout@v7` → `actions/setup-node@v7`（Node 24，与 `engines: >=22` 的实测版本一致）
2. `npm ci`
3. 算发布计划：校验版本号合法、tag 与版本一致，定出 dist-tag（手动触发时若带了 `tag` 输入又没开演练，直接拒绝）
4. `npm run check` —— 客户端语法检查 + 全部测试
5. 查 npm 上该版本是否已存在；存在就直接失败（npm 不允许覆盖同一版本，与其让 `publish` 报 E409，不如提前说清楚）
6. `npm pack --pack-destination dist` → 产物白名单由 `package.json` 的 `files` 决定
7. 把 tgz 作为 artifact `npm-tarball` 传给下一个 job

**publish job**（唯一有 `id-token: write` 的 job，全程没有静态凭据）：

8. 下载 artifact（**不重新 checkout、不重新打包**：测过的字节就是要发布的字节）
9. 「确认 OIDC 通路」：npm 版本 ≥ 11.5.1、`ACTIONS_ID_TOKEN_REQUEST_URL` 存在（= 权限里有 `id-token: write`），否则当场失败并指名缺什么
10. `npm publish ./<tgz> --tag <dist-tag> --access public --registry https://registry.npmjs.org --provenance`

这一步的 `setup-node` **故意不传 `registry-url`**（registry 由发布命令的 `--registry` 显式指定）。原因见下面的踩坑：`registry-url` 会生成一个空的 `${NODE_AUTH_TOKEN}` 占位凭据，把 npm 的"有没有凭据"信号污染成"有"，于是 OIDC 失败也会被静默吞掉。

发行 tarball 而不是目录，和 Trusted Publishing 并不冲突：OIDC 交换是按**包名**做的（`.../oidc/token/exchange/package/<包名>`），包名从 tgz 里的 `package.json` 读出，所以 `npm publish ./x.tgz` 一样走 OIDC。

dist-tag 规则：版本号含 `-`（如 `0.2.2-rc.1`）→ `next`，否则 → `latest`。**预发布版不会污染 `latest`**，所以 `npm install @lolkda/dsh-skills-manager` 永远拿到正式版。

`--provenance` 用的是和认证同一个 id_token，attestation 会显示在包页面上（"Built and signed on GitHub Actions"）。另外 npm 对公开仓库 + 公开包会**自动**开启 provenance，显式传 `--provenance` 只是把这件事钉死。

## 只演练、不发布

Actions 页面 → Publish to npm → **Run workflow**，`tag` 填 `v0.2.2`、`dry-run` 勾上。verify 全跑，publish 走 `npm publish --dry-run`。

`tag` 输入**只能用于演练**：它只是一个字符串，证明不了那个 tag 真的指向当前提交。真实的手动发布请把界面的 **Use workflow from** 选成要发布的 tag（这时 `GITHUB_REF=refs/tags/...` 由 GitHub 保证，`tag` 输入留空即可），或者干脆 push tag；带着 `tag` 输入做非演练发布会直接被拒。

**注意 dry-run 的默认行为会让你误判**：`npm publish --dry-run` 在完全没有任何凭据时，只 warn 一句 `This command requires you to be logged in to ... (dry-run)`，然后 **exit 0**。也就是说裸的 dry-run 根本验证不了认证通路 —— 而认证恰好是第一次上 Trusted Publishing 最常配错的地方。所以本 workflow 的 dry-run 额外做两件事：把 npm 日志当判据，出现那句 "requires you to be logged in" 就 **`::error` 失败**；再单独报告 OIDC 交换的结论（成功/未见记录）。这样 dry-run 才真的能当作"发布前的预演"。

## 本地预检（不改动 npm 上任何东西）

```bash
npm ci
npm run check
mkdir -p dist && npm pack --pack-destination dist   # 看一眼产物内容
tar -tzf dist/*.tgz | sort
```

本地**没法**验证 OIDC：OIDC 只在 CI 里存在（`lib/utils/oidc.js` 明确只在 GitHub Actions / GitLab / CircleCI 环境下才尝试交换，本机直接 return）。在本地跑 dry-run 得到的「通过」只说明没写出格式错误的东西，不代表 CI 里的认证会成功 —— 认它要看 Actions 里那次 dry-run 的日志。

## 实测踩过的坑

这些都在本机真跑过，写下来免得下次重踩：

- **`npm pack --pack-destination dist` 不会自己建目录**（npm 11 实测 ENOENT），必须先 `mkdir -p dist`。
- **`npm publish dist/x.tgz` 里的斜杠会被 npm 当成 GitHub 简写**，报一个跟 npm 无关的 `git ls-remote ssh://git@github.com/dist/x.tgz.git` 错误。传参必须写成 `./x.tgz`。
- **环境变量里的 `npm_config_registry` 会压过项目级 `.npmrc`**（自建 runner 上很常见）。所以 publish 和「版本是否已存在」两处都显式带 `--registry https://registry.npmjs.org`，保证判断和推送指向同一个 registry。
- **`--provenance` 在本地非 GitHub 环境下会被静默跳过**（不报错、exit 0），只有真的跑在 Actions 里才会生成 attestation。本地 dry-run 通过不代表 provenance 一定生效。
- **npm 的 `files` 支持否定模式**：`"!scripts/release-plan.mjs"` 实测有效（打包后 19 个文件，`scripts/` 下只剩 `migrate-external-skills.mjs`）。
- **`setup-node` 的 `registry-url` 会埋一颗雷**：它写出的 `.npmrc` 里是
  `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}`；当 `NODE_AUTH_TOKEN` 没配置时，npm **不**把它当成空值，而是当成一个"存在但无效"的凭据（实测该目录下 `npm whoami` 直接 401，且 npm 内部的 `noCreds` 判断为假）。后果有两个：OIDC 交换失败不再有任何提示；`npm publish --dry-run` 甚至连那句 "requires you to be logged in" 的 warn 都不打，于是演练看起来一切正常。所以 publish job 不传 `registry-url`。
- **本机 `.npmrc` 里已有的凭据会让本地 dry-run "看起来认证过了"**。这台机器上 `/app/.home/.npmrc` 里就有一份对 `registry.npmjs.org` 有效的凭据（`npm whoami` 返回 `lolkda`），所以本地 dry-run 有没有 token 都会过；在 GitHub runner 上不存在这种东西，别把本地的通过当成 CI 的通过。
- **`/app/.home/.npmrc` 里的有效凭据和用户给的那个 token 不是同一个**。用户给的那个 token 在 2026-09-24 14:15Z 时 `GET /-/whoami` 返回 200，15:39Z 同一 token 返回 401（同一时刻 `/app/.home/.npmrc` 里的凭据仍然 200）—— 说明它在这中间被吊销/轮换了。这正是改用 OIDC（不依赖任何长期 token）的实际理由。

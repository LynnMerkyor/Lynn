# Lynn 发版 SOP(单一入口)

> 从「改版本号」到「公网 URL 验证」的一条龙顺序。本文是**索引型 SOP**:每步给命令和坑位,
> 细节以被引文档为准,**不要在别处复制本流程**(会漂移)。
>
> 引用地图:
> - 门禁分层与阻断规则 → [`docs/RELEASE-REGRESSION-GATES.md`](../RELEASE-REGRESSION-GATES.md)
> - 镜像站路径/上传/验证 → [`docs/ops/download-site-deploy-map.md`](download-site-deploy-map.md)
> - 安装片段(发版页/Release notes 用)→ [`docs/ops/v080-cli-install-release-snippet.md`](v080-cli-install-release-snippet.md)
> - 公证 → `scripts/notarize.cjs` + `scripts/finalize-macos-dmg.sh`
> - 门禁脚本入口 → `scripts/release-gate.mjs`(含 `--quick/--no-ui/--no-cli-task` 等开关)
> - Brain 发布(独立节奏)→ `scripts/mirror-prod-diff.sh`(mirror↔prod 漂移检测,部署前必跑)

---

## 0. 前置自检(5 分钟,省一下午)

```bash
git status -sb                       # 工作树必须干净;在 worktree 干活则先 diff -rq <worktree> <主仓>
node -p "process.arch"               # 必须 arm64(本机)
file node_modules/better-sqlite3/build/Release/better_sqlite3.node | grep arm64 \
  || npm rebuild better-sqlite3      # ⚠ 事故记录 2026-06-10:x86_64 残留导致 GUI 启动连环崩(#72 同类)
```

- ⛔ **`STEP_TEXT_MODEL` 必须 = `step-3.7-flash`**(CLAUDE.md 纪律;2026-06-07 曾被静默降到 3.5 跑了大半天)。
- 本分支若含 `.github/workflows/*` 改动,**PAT 无 workflow scope 会 push 失败**——先隔离该 commit 或换有 scope 的凭证。

## 1. 版本号(一个数字,N 个落点)

| 落点 | 文件 |
|---|---|
| 根版本 | `package.json` `version` |
| CLI 版本 | `cli/package.json` `version`(与根同步) |
| README 必须提到当前版本 | `README.md` + `README_EN.md`(static gate 会查;**hotpatch 子条目并入当前版本条目**,不另起) |
| 安装片段 tarball URL | `docs/ops/v080-cli-install-release-snippet.md`(`lynn-cli-<ver>.tgz`) |
| 镜像静态页 | 见第 6 步:**3 文件 × 4 处 = 12 个替换** |

## 2. 门禁(必须全绿才进入打包)

```bash
npm run release:preflight
# = 单测(root+brain) + typecheck×2 + CLI 全家桶 + 构建×3 + static gate + UI smoke
#   + gate:startup(GUI 冷启动三矩阵:fresh / corrupt-db / .hanako 哨兵 —— issue #72 回归网)
#   + gate:cli-task(CLI 真任务执行:可见答案 / usage 单行 / fast 档 —— 思考不说话回归网)
```

分步跑/跳过用 `npm run release:gate -- --help` 看开关。阻断规则(blocker/critical/extended)见
[RELEASE-REGRESSION-GATES.md](../RELEASE-REGRESSION-GATES.md)。

- ⚠ `LYNN_UI_SMOKE=1` 的 UI smoke **不覆盖 server 启动链**(它 createMainWindow 后直接 return)——
  #72 当年就是这么漏的。`gate:startup` 跑的才是真启动链,两者都要绿。
- `gate:cli-task` 需要 Brain 在线;Brain 离线 = 门禁失败(路由不可用不许放行)。

### 2.1 真实安装包门禁(覆盖线上前必须过)

无论是新版本发布还是**同版本热修覆盖**,打包后的候选包都必须先安装成真实 App,由执行者完成
**自动安装包门禁 + 人工按钮矩阵**,并把结果交给用户确认。**用户确认前不得 rsync 镜像站、不得覆盖 Release 资产。**

自动安装包门禁:

```bash
npm run release:installed-gate
```

这条会使用 `/Applications/Lynn.app` 的真实包,不是源码 dev server:

- 打包版 server smoke:原生模块 ABI、冷启动、health、污染配置修复。
- 打包版 CLI smoke:从 `Lynn.app/Contents/Resources/cli/` 直接启动,确认不是全局旧拷贝。
- 打包版 Settings/Provider smoke:真实 Electron 窗口 + CDP 点击,覆盖 Provider 去重、Key 状态、删模型不回流。
- 真实 GUI server 并发复查:对当前安装包发 3 个并发 Hanako 自动复查请求,必须收到非空 `review_result`,防止空卡/串模型/并发覆盖。

人工按钮矩阵(必须逐项点击并记录截图或日志路径):

- Chat 主界面:发送短答、停止按钮、编辑重发、恢复草稿、复制、朗读、翻译、复查、Hanako 复查卡片展开/后续任务。
- 输入区:模型下拉、自动/深研/执行模式、附件按钮、麦克风按钮、右侧书架按钮、窗口非全屏宽度下输入区不截断。
- Settings:首页、模型服务列表、Provider 详情、API Key 测试、读取模型、删除模型、Voice、Bridge、Security。
- CLI:打包版 `lynn version`、进入 chat、搜索工具问答、`/voice` 入口 smoke;如本次改动涉及 CLI UI,还要截图/录屏确认。
- 下载包一致性:本地待验包 hash 记录在验收说明里;线上覆盖后必须再用公网 URL 下载并比对 hash。

这条是 2026-06-13 #74 同版本覆盖事故后的硬纪律:只跑自动门禁不等于可发布;只看源码不等于包体可用。

## 3. CLI 包 → 镜像

按 [download-site-deploy-map.md §CLI Release Checklist](download-site-deploy-map.md) 四步走:
`pack:cli` → scp 到 **`/opt/lobster-brain/public/downloads/cli/`** → `curl -fsSIL` 验公网 URL + sha256 → 
`LYNN_CLI_TARBALL_URL=… npm run test:cli-install:remote`。

- ⛔ **CLI 资产路径是 nginx alias `/opt/lobster-brain/public/downloads/cli/`,不是 `/var/www/download-site/downloads/`**
  ——传错位置公网不更新且无报错(历史踩过)。

## 4. GUI 包(每平台都要自己的 server bundle)

```bash
export APPLE_NOTARY_PROFILE=lynn-notary    # ⚠ 脚本默认值是 hanako-notary,必须显式覆盖
npm run dist        # macOS(自动先跑 release:preflight;build:server 已含)
npm run dist:win    # Windows x64(仅 x64,⛔ 不出 ARM64 Windows)
```

- ⛔ **正式发布严禁使用 `npm run dist:local` 或任何 `SKIP_NOTARIZE=true` 产物**。`dist:local` 只给本机测试/安装 smoke 用；只要要同步镜像站、Gitee Release 或 auto-update,macOS DMG 必须走 `npm run release:finalize-mac`。
- dmg **改名后再发布**:arm64 → `Lynn-<ver>-macOS-Apple-Silicon.dmg`,x64 → `…-Intel.dmg`。
- 公证+装订+验证一条龙:`npm run release:finalize-mac`(= `scripts/finalize-macos-dmg.sh`,
  notarytool submit --wait → stapler staple → Gatekeeper 验证)。

## 5. 更新清单(manifest)

```bash
npm run release:manifest
```

- ⛔ `.github/update-manifest.json` 与站点页面的 `.dmg/.exe` 链接**必须指腾讯镜像
  `https://download.merkyorlynn.com/downloads/…`,严禁 GitHub 直链**(static gate 强制)。

## 6. 上传镜像 + 静态页版本(两步,缺一不可)

1. **rsync 资产**(installers + blockmaps + `latest-mac.yml`/`latest.yml`)到
   **`tencent:/opt/lobster-brain/public/downloads/`** —— 见 [deploy-map §GUI](download-site-deploy-map.md)。
2. **sed 静态页版本号**:`/var/www/download-site/{index.html,download.html,app.js}`
   **3 文件 × 4 处 = 12 个替换**。⛔ **rsync ≠ 更新首页**——只做第 1 步用户看到的还是旧版本。

验证公网(不是验证服务器文件):对 6 个资产 URL + 2 个 yml 全部 `curl -fsSIL` 200,见 deploy-map 命令块。

## 7. GitHub Release

3 个资产(Apple-Silicon.dmg / Intel.dmg / Windows-Setup.exe)+ CLI tarball。

⛔ **Release body 顶部必须先放“国内镜像站下载（推荐）”区块**。GitHub Assets 只能作为备用下载,
不能让国内用户先点 GitHub。缺这个区块 = Release 不合格,必须补完再发布。

模板(版本号必须替换成当次版本):

````md
## 国内镜像站下载（推荐）

国内用户请优先使用以下镜像站地址；GitHub Assets 作为备用下载。

- **CLI**:

  ```bash
  npm install -g --force "https://download.merkyorlynn.com/downloads/cli/lynn-cli-<ver>.tgz"
  ```

- **macOS Apple Silicon / ARM64**: https://download.merkyorlynn.com/downloads/Lynn-<ver>-macOS-arm64.dmg
- **macOS Intel / x64**: https://download.merkyorlynn.com/downloads/Lynn-<ver>-macOS-x64.dmg
- **Windows x64**: https://download.merkyorlynn.com/downloads/Lynn-<ver>-Windows-Setup.exe
- **下载页**: https://download.merkyorlynn.com/download.html
````

其后再贴发版说明正文和 [安装片段](v080-cli-install-release-snippet.md)(记得片段里 tarball 版本已在第 1 步更新)。

## 8. Gitee Release + 双远端同步

GitHub 和 Gitee 都是正式发版记录,不能只更新一边。GitHub Release 承担全球 release 资产页,
Gitee Release 承担国内代码/版本记录；二进制下载默认仍走腾讯镜像站。

```bash
VERSION="$(node -p "require('./package.json').version")"

git push github-lynnmerkyor main
git push github-lynnmerkyor "v${VERSION}"

git push gitee main
git push gitee "v${VERSION}"

npm run release:verify-remotes
```

- ⛔ **Gitee push 失败 = 发版未完成**,不能只在 GitHub Release 发完就向用户宣布“已全量发布”。
- Gitee Release 页面必须创建/更新 `v<version>` 记录,正文与 GitHub Release 保持同一份版本说明,顶部同样优先放腾讯镜像下载区块。
- 如果 Gitee UI/API 暂时不能自动创建 Release,至少必须完成 `main` + `v<version>` tag 同步,并在交付说明里写清“Gitee Release 页面待人工补正文”。这不是通过项,只是阻断原因记录。
- `npm run release:verify-remotes` 会校验 `github-lynnmerkyor` 与 `gitee` 的 `main` 和 `v<package.version>` tag 是否都指向本地应有提交；失败时先修远端同步,不要继续交付。

## 9. 装后验证(发布 ≠ 完成)

```bash
# 真实安装包 smoke(装到 /Applications 后)
npm run test:release:live      # 连本机已启动的打包版 Lynn
```
最后过一遍 [人工 UI Gate 八项](../RELEASE-REGRESSION-GATES.md)(首屏/短答/工具/长输出/diff/Settings/Voice/Bridge)。

## 10. 交付(给用户的最后一条消息)

⛔ **6 条直链一次性全给,不要问**:GitHub 3(arm/intel/win)+ 腾讯镜像 3(同三个)。
测试链接同样两边都给(镜像规则管的是站点默认,不管对用户的交付)。交付里还要给:

- GitHub Release: `https://github.com/LynnMerkyor/Lynn/releases/tag/v<version>`
- Gitee Release: `https://gitee.com/merkyor/Lynn/releases/tag/v<version>`
- `npm run release:verify-remotes` 的通过结果。

---

## 附:掉坑索引(每条都真实发生过)

| 坑 | 后果 | 防线 |
|---|---|---|
| `STEP_TEXT_MODEL` 被静默改 3.5 | 主力降级跑了大半天 | CLAUDE.md ⛔ 纪律 + .env 注释守卫 |
| x86_64 原生模块残留(better-sqlite3) | GUI 启动连环崩(#72 同类) | 第 0 步 `file` 自检 + `gate:startup` 预检 |
| UI smoke 跳过 server 启动链 | #72 漏到生产(用户打不开) | `gate:startup` 三矩阵(fresh/corrupt-db/hanako) |
| CLI 资产传到 `/var/www/...` | 公网 404/旧版,无报错 | 第 3 步 ⛔ + deploy-map 表 |
| 只 rsync 不 sed 静态页 | 用户看到旧版本号 | 第 6 步两步制 + 12 处替换口诀 |
| manifest/站点指 GitHub 直链 | 国内用户下不动 | static gate 强制 + 第 5 步 ⛔ |
| GitHub Release 没有国内镜像区块 | 用户默认点 GitHub Assets,国内下载慢/失败 | 第 7 步 ⛔ 模板 |
| dmg 不改名直接发 | 命名与历史版式不一致 | 第 4 步改名规则 |
| 平台缺各自 server bundle | 装上打不开 | `dist`/`dist:win` 内置 build:server,别绕过脚本 |
| PAT 缺 workflow scope | push 被拒 | 第 0 步检查 `.github/workflows` 改动 |
| mirror↔prod 漂移(Brain) | 部署覆盖手工修复 | `scripts/mirror-prod-diff.sh` 硬信号门 |

# v0.86.8 发布检查记录

用户授权：2026-09-08「开发完成就走打包公证发新版流程」。此授权覆盖本次开发完成后的测试、三平台打包、macOS 公证、安装包验收及四个出口发布；执行中不重复请求发布授权。

范围：历史正文搜索、轻量自动化、统一会话文件、手机 PWA 续聊、通用 MCP OAuth、Kimi Datasource 自行扫码；保留默认关闭的可选树影。

基线：`cea54f4fd2aa6aafe476a4c532bdccb4300b349c`（v0.86.7）；发布分支 `codex/release-v0.86.8`。只写当前隔离工作树，不修改 Downloads/Lynn 的用户文件或无关模型资产。

## 执行状态

- [x] 三远端 main 基线一致，v0.86.8 尚不存在；签名身份可用。
- [x] 根/CLI 版本、锁文件、README、站点、安装片段及中英文说明更新。
- [x] 发布清单生成。版本静态验证在完整门禁中执行。
- [ ] `release:overnight` 全链路通过（含 full-gate、真实 CLI/GUI 任务与夜间回归）。失败保留记录并修复，不能跳过门禁发布。
- [ ] CLI tarball 与 macOS arm64/x64、Windows x64 三个平台候选包生成。
- [ ] macOS App/DMG 签名、公证、装订及 Gatekeeper 通过；最终字节重新生成 blockmap/yml。
- [ ] 真实候选 App 自动验收与人工按钮矩阵，记录包体 SHA-256 和结果。
- [ ] 腾讯镜像：3 安装包、blockmaps、2 yml、CLI tarball 与 index.html/download.html/app.js。
- [ ] GitHub LynnMerkyor/Lynn：main/tag、Release 正文与资产，独立回读。
- [ ] GitHub MerkyorLynn/Lynn：main/tag、Release 正文与资产，独立回读。
- [ ] Gitee merkyor/Lynn：main/tag 和 Release 正文，独立回读。
- [ ] 公网 URL/完整 SHA-256、CLI 远端安装与 release:verify-remotes 全部通过。

证据目录：`output/release-v0.86.8/`（不提交原始日志和凭据）。开发验证见 `docs/DEV-VERIFICATION-functional-kimi-20260908.md`，不能代替本次发布门禁。

## 本地缓存构建

`scripts/build-server.mjs` 支持 `LYNN_BUILD_OFFLINE=1`（缺失缓存即停止，不下载）和 `LYNN_BUILD_DEPS_ROOT`（按 mac-arm64/mac-x64/win-x64 查找独立依赖目录）。先验证依赖声明完全一致，再复制已有 node_modules 并执行 external、资源追踪和运行时验证。依赖缓存版本号不代表目标版本已通过验证，必须跑新 bundle 与实际包体门禁。

本次只复用 Mac 上已有的 Node/Electron/依赖缓存，不下载模型、数据集或新运行时到 Mac。隐藏 UI 测试设置 `LYNN_UI_HEADLESS=1` 和独立 `LYNN_HOME`，不改变个人使用窗口。

`LYNN_GATE_CLEAN_SCOPE` 将旧测试清理限制到本次证据目录，保留其他任务测试数据；本次使用全新隔离目录。

## 阻断与修正记录

第一次 overnight 在 prerelease:preflight 失败：共享 better-sqlite3 为 Node ABI 127，旧前置脚本只允许 Electron ABI 139。脚本在探测前刷新了共享模块的 ad-hoc 签名；未替换模块代码或版本，但该签名写入超出隔离预期，已向用户披露。后续 root node_modules 改为本任务独立副本。前置检查遵循 desktop/server-process.cjs 已有 LYNN_SERVER_NODE_BIN 入口，实际打开 SQLite 数据库验证；不指定入口仍使用 Electron。正式包独立 Node/SQLite 由安装包门禁验证。

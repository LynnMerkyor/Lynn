# V0.87.1 非阻断问题跟进 / Non-blocking follow-ups

2026-10-11：按 Lynn 明确要求，非启动阻断问题保留证据，留待后续版本处理，不继续扩大本次发布范围。

## 手动复查的相关性与会话材料

- 一次 GUI 按钮测试的原答为“安装包按钮验收已准备好”。真实复查返回了缺少会话文件、需要验收材料的结论，并发生主候选超时后切换；耗时约 67 秒。
- 这不是启动故障，也不是鉴权失败的固定兜底，但复查偏离简单原答的现象需要后续调查。不要把模型关于文件缺失的自述直接认定为客户端确实丢失文件。
- 明确算术用例的 GUI 按钮复查随后通过；ARM64 与 Intel 安装包的手动算术纠错及并发复查均通过。
- 后续验收：区分原答已包含的事实、外部证据和会话文件引用；验证复查相关性、文件可访问性及候选切换耗时，不靠固定结论兜底。
- 原始证据：发布证据目录 `output/release-v0.87.1/resume-20261011/` 中的 `installed-buttons-final3-ambiguous.log`、`installed-buttons-1791728248547/results.json`、`installed-buttons-final3.log` 和两份 `installed-final3-*.log`。

## 原生识图的重复收尾

- ARM64 的默认 Step 5 识图成功回答“红色”，随后多了一句“上一个回答只有‘红色’两个字，已经完整，没有剩余正文”；无备用模型切换。
- Intel 同用例仅返回“红色”。这属于非阻断的输出整洁度问题，后续检查续写与完成事件处理，不将本次单次现象推断为固定故障。
- 证据：`installed-final3-arm64.log` 与 `installed-final3-x64.log`。

## English summary

Two non-blocking observations remain for a later release: manual review relevance and fallback latency on an ambiguous readiness statement, and one redundant completion sentence after successful native Step 5 image recognition. Clear arithmetic button review and both installed-package review gates passed. Original evidence is retained; neither observation is reported as fixed by V0.87.1.

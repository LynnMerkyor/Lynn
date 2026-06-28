**总判定：部分成立。**

你的核心方向是对的：`17/20` 和 `13/20` 若确实来自 SOLO eval vs `agent20.mjs` 两套 benchmark，就不能直接比较；DS V4 Pro 也确实不能当单一真值判官。但“Step-3.7-Flash 没有退化”和“真正不稳定的是判官而非模型”这两个说法都偏满，现有数据只能支持“没有证明退化，且判官噪声很大”。

**1. Step-3.7-Flash 没退化？**

部分成立。当前目录数据能确认 SOLO 三次相关数字：

- 上周 DS：`17/20`
- 本周 run1 DS：`14/20`
- 本周 keep DS：`16/20`
- keep 人工/Claude 记录真值：`19/20`

但要挑刺：当前目录没有 `agent20.mjs` 或那套 `13/20` 原始记录，所以“17/13 是两套 benchmark 混淆”我只能按 brief 采信，不能独立验证。

同一 SOLO 上，`pipeline_pass` 视角是：上周 `18/20`、run1 `16/20`、keep `19/20`。这说明没有稳定退化证据，但也不能证明“没退化”。run1 里确有真实管线失败，如 7/11/12/13，不全是 DS 错判。

**2. DS 判官不稳定/不准是否被充分支撑？**

“DS 不稳定”成立：`ds_judge_consistency.json` 显示同一批 keep 轨迹重复判 5 次，总分 `[17,16,15,16,15]`，题 11/15/17/19 翻供。哪怕 temp=0 不保证后端确定性，这对 eval 来说仍是判官栈不稳定。

“不准”也有证据，但没有完全闭环。漏洞是：

- `judge_consistency.py` 里的 ground truth 是硬编码 `GROUND[3]=False`，不是独立标注文件。
- 脚本传给 DS 的不是完整轨迹，而是 `arg[:80]`、`obs[:150]` 的压缩视图；如果这不是原 harness 的真实输入，就不能说“完整相同轨迹”。
- N=5 足以证明会翻供，不足以精确估计误判率。
- `null`/超时计失败可以证明评测链路不可靠，但会把 API/解析失败混入语义误判。
- DS 不是只假阴性：run1 和上周的题 13 有 `pipeline_pass=false` 但 `success=true`，即假阳性风险。

所以更准确说法是：DS V4 Pro 作为单次 LLM judge 明显不可靠；但模型/工具/harness 本身也有 run-to-run 波动，不能把全部不稳定都归给 DS。

**3. 题 3 算能力失败还是 harness 格式严格度问题？**

在这个 agent/harness benchmark 下应算失败。keep 轨迹只有 final 里的 `<tool_call>{...}`，没有被 harness 识别成 `<code_run>`，`n_verify=0`、`pipeline_pass=false`、`success=false`。这不是 DS 误判。

可以说它更像“工具协议/格式遵循失败”，不是纯算法编码失败；但 agent benchmark 测的就是端到端完成任务能力，协议失败也应扣分。对外数字应是 `19/20`，不是 `20/20`。

**4. 对外最终数字怎么测？**

建议不要对外报单次 DS 分。短期可写：

`SOLO keep 单次：DS V4 Pro 判 16/20；人工复核/执行证据判 19/20，唯一失败为题 3 工具格式失败。该数字不是稳健回归结论。`

正式对外应这样测：

- 固定并记录 benchmark 文件 hash、harness commit、judge prompt、模型版本/endpoint、环境镜像、依赖版本、max_steps/workers。
- 每个配置至少跑 `10` 个独立 run，20 题太小，单轮分数波动会很大。
- 优先用每题确定性 checker/隐藏测试作 oracle，不用 LLM judge 当真值。
- 无法自动判的题，用盲审：至少 2 个独立强模型或人工标注，冲突再仲裁。
- judge 调用失败/null 应重试；最终仍失败应单列为 “judge infra failure”，不要直接混入模型失败。
- 报均值、标准差/置信区间、逐题 pass rate，而不是只报一个最好或最后一次分数。

**漏洞清单**

- 当前目录不能独立证明 `13/20` 的来源。
- 没有完整命令、harness hash、prompt hash、模型快照、环境信息。
- JSON 里的 `arg`、`final`、部分 `obs` 明显截断，不等于完整轨迹。
- `review_record.json` 是结论表，不是独立复核证据。
- DS 一致性实验的 ground truth 硬编码。
- 一致性脚本使用压缩轨迹，和“完整执行轨迹”表述不一致。
- N=5 只能证明翻供，不能量化总体误差。
- null/超时混入了语义判错统计。
- run1 有真实管线失败，不能说只有判官不稳。
- DS 有假阳性，不只是把正确题打错。
- 多数题依赖模型自写测试，缺少隐藏 oracle。
- 题 3 应算端到端失败，不能用“格式严格”抹平。
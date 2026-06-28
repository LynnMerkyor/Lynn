# 复核请求 (给 GPT-5.5 XH):一个工程结论,请挑刺,别背书

## 背景与待复核结论
用户怀疑本地评测里 Step-3.7-Flash 编排器"退化了"(上周一组分数高、这周一组分数低)。我(Claude)调查后给出结论,请你严格复核、找漏洞:

**我的结论:**
1. 用户看到的"上周17 / 这周13"是**两套不同 benchmark 混淆**:17/20 来自 SOLO 编排 eval(`orch_eval_3way`,20 道任务,harness `eval_orch_review.py`);13/20 来自另一套编码电池(`agent20.mjs`,10 Python+10 JS,2026-06-25 才新建)。两者任务集、判定方式都不同,不可比。
2. 在**同一套 SOLO benchmark** 上,用完全相同的命令复测当前 Step-3.7-Flash(orch=exec=step37,review=none,max_steps=10,workers=3,judge=deepseek-v4-pro):
   - DS V4 Pro 判官:上周 17、本周 run1=14、本周 keep=16。
   - 我(Claude)按真值复核(亲自复跑每题 pytest + 读完整执行 obs,keep run 保留了 workdir)= **19/20**。
3. **Step-3.7-Flash 没有退化。真正不稳定/不准的是判官 DS V4 Pro。**

## 关键证据:判官自一致性实验
把 keep run 那 20 条**完全相同的执行轨迹**,用 DS V4 Pro(temp 0,和 harness 判官完全一致的 prompt)**重复判 5 次**(数据见 `ds_judge_consistency.json` / `.log`):
- 每轮总分:**[17, 16, 15, 16, 15]** —— 模型输出 100% 不变,判官自己就给出 15~17 分,**极差 2 分纯来自判官**。
- 4 道题在相同输入下翻供:11、15、17、19(temp 0 仍 True/False 乱跳;11 还有 2 次判官调用直接 null/超时,harness 把 null 当失败)。
- DS 多数判 vs 我真值不一致 3 道:2(quicksort,DS 稳定误判 False,实则 200 随机数组全过)、11(deep_merge,12 pytest 全过)、19(词频,验证通过)。
- 唯一真失败:题3 销售CSV(模型最后吐 `<tool_call>{...}` JSON 而非 harness 认的 `<code_run>`,没执行,工作目录空 —— 是工具格式幻觉,不是编码能力)。

## 请你回答
1. "Step-3.7-Flash 没退化"这个结论是否成立?有没有被我忽略的混淆变量?
2. "不稳定/不准的是判官 DS V4 Pro 而非模型"——判官自一致性实验(同输入 [17,16,15,16,15])是否足以支撑?有没有方法论漏洞(例如 temp0 下 DS 非确定性是否被我误读、null 计失败是否夸大、N=5 是否太小、单 keep run 的轨迹是否有代表性)?
3. 题3 到底算"能力失败"还是"harness 格式严格度问题"?这影响最终是 19 还是 20。
4. 如果要给一个能对外引用的最终数字,你建议怎么测(轮数、判官选择、是否换 Claude/多判官投票当真值)?

数据文件都在当前目录:`review_record.json`、`step37_solo_retest_KEEP_20260627.json`(含完整 obs)、`step_rash_20260618_lastweek.json`(上周原始)、`ds_judge_consistency.json`、`REVIEW_RECORD.md`。请读完再下判断。直接给结论 + 漏洞清单,不要客套。

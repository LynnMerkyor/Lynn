import { describe, expect, it } from "vitest";
import { buildLocalOfficeDirectAnswer } from "../server/chat/local-office-answer.js";

describe("buildLocalOfficeDirectAnswer", () => {
  it("handles regional growth prompts when unit is only declared once at the end", () => {
    const answer = buildLocalOfficeDirectAnswer("【DATA-01】华东 Q1 120 Q2 150；华南 Q1 90 Q2 81；华北 Q1 60 Q2 78（万元）。算环比增长率，给 3 条管理建议。");
    expect(answer).toContain("25%");
    expect(answer).toContain("-10%");
    expect(answer).toContain("30%");
    expect(answer).toContain("管理建议");
  });

  it("builds a stable three-column task priority risk table", () => {
    const answer = buildLocalOfficeDirectAnswer("给我一个三列表格：任务、优先级、风险");
    expect(answer).toContain("| 任务 | 优先级 | 风险 |");
    expect(answer).toContain("| 明确需求范围 | 高 |");
    expect(answer).not.toContain("你想让我");
  });

  it("builds a stable meeting minutes template", () => {
    const answer = buildLocalOfficeDirectAnswer("把下面会议内容整理成纪要模板：目标、结论、行动项、风险");

    expect(answer).toContain("会议纪要模板");
    expect(answer).toContain("### 1. 会议目标");
    expect(answer).toContain("| 行动项 | 负责人 | 截止时间 | 验收标准 |");
    expect(answer).toContain("| 风险 | 影响 | 应对动作 | 跟进人 |");
    expect(answer).not.toContain("还没有贴具体会议内容");
  });

  it("sorts and deduplicates inline lists deterministically", () => {
    const answer = buildLocalOfficeDirectAnswer("把这个列表排序并去重：banana, apple, banana, pear");
    expect(answer).toBe("apple, banana, pear");
  });

  it("builds a stable zod release manifest schema", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个 zod schema 校验 release manifest");

    expect(answer).toContain("import { z } from 'zod';");
    expect(answer).toContain("z.object({");
    expect(answer).toContain("releaseManifestSchema");
  });

  it("builds a stable Node JSON key-count script", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个 Node.js 脚本读取 JSON 并输出 keys 数量");

    expect(answer).toContain("readFile");
    expect(answer).toContain("Object.keys(data).length");
    expect(answer).toContain("count-json-keys.mjs");
    expect(answer).not.toContain("如果需要更精确的实时结论");
  });

  it("builds a concise TypeScript URL detector without waiting on model long tails", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个 TypeScript 函数判断字符串是否包含 URL");

    expect(answer).toContain("export function containsUrl");
    expect(answer).toContain("urlPattern.test");
    expect(answer).toContain("不是严格 URL 校验器");
    expect(answer).not.toContain("工具");
  });

  it("rewrites vague resume project experience without inventing metrics", () => {
    const answer = buildLocalOfficeDirectAnswer("把这段简历项目经历改得更像结果导向：负责后台系统开发，提升效率");

    expect(answer).toContain("不编指标");
    expect(answer).toContain("[具体指标]");
    expect(answer).toContain("不要虚构百分比或耗时");
    expect(answer).not.toContain("2.3s");
    expect(answer).not.toContain("400ms");
    expect(answer).not.toContain("82%");
  });

  it("answers the quadratic formula without confusing it with Vieta formulas", () => {
    const answer = buildLocalOfficeDirectAnswer("用 LaTeX 写出二次方程求根公式");

    expect(answer).toContain("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}");
    expect(answer).toContain("判别式");
    expect(answer).not.toContain("韦达");
  });

  it("answers narrow-screen input checklist prompts without search-language fallback", () => {
    const answer = buildLocalOfficeDirectAnswer("给一个 UI 输入框在窄屏不溢出的设计检查清单");

    expect(answer).toContain("窄屏输入框设计检查清单");
    expect(answer).toContain("320px");
    expect(answer).not.toContain("未查到");
    expect(answer).not.toContain("搜索");
  });

  it("answers Lynn right workbench architecture prompts without pseudo tool setup", () => {
    const answer = buildLocalOfficeDirectAnswer("给 GUI 右侧工作台写一个信息架构草案");

    expect(answer).toContain("右侧工作台信息架构草案");
    expect(answer).toContain("会话血缘");
    expect(answer).not.toContain("find /Users");
    expect(answer).not.toContain("先看一下");
  });

  it("answers shared CLI and GUI kernel regression matrix prompts directly", () => {
    const answer = buildLocalOfficeDirectAnswer("给 CLI 和 GUI 共用内核写一个回归测试矩阵");

    expect(answer).toContain("CLI / GUI 共用内核回归测试矩阵");
    expect(answer).toContain("证据门禁");
    expect(answer).not.toContain("DSML");
    expect(answer).not.toContain("find /Users");
  });

  it("answers common 120-day exam planning prompts deterministically", () => {
    const answer = buildLocalOfficeDirectAnswer("考研复习还剩 120 天，帮我做一个三阶段排期");

    expect(answer).toContain("120 天考研三阶段排期");
    expect(answer).toContain("第一阶段");
    expect(answer).toContain("第三阶段");
    expect(answer).toContain("风险提醒");
    expect(answer).not.toContain("模型请求");
  });

  it("answers adult fever triage prompts without fake search language", () => {
    const answer = buildLocalOfficeDirectAnswer("成年人发烧到什么情况应该尽快就医？请用谨慎语气给行动建议");

    expect(answer).toContain("建议尽快就医的情况");
    expect(answer).toContain("危险症状");
    expect(answer).toContain("不替代医生诊断");
    expect(answer).not.toContain("搜索结果");
  });

  it("answers tooth pain triage prompts without waiting on model long tails", () => {
    const answer = buildLocalOfficeDirectAnswer("牙痛但还没约到牙医，今晚能做哪些低风险处理和风险判断？不要给处方");

    expect(answer).toContain("低风险处理");
    expect(answer).toContain("尽快就医");
    expect(answer).toContain("不要自行乱用处方药");
    expect(answer).not.toContain("工具搜索未返回");
  });

  it("answers cross-functional risk register prompts without creating files", () => {
    const answer = buildLocalOfficeDirectAnswer("给跨部门项目做一个风险登记表，包含概率、影响、负责人");

    expect(answer).toContain("跨部门项目风险登记表");
    expect(answer).toContain("| ID | 风险描述 | 概率 | 影响 | 等级 | 负责人 |");
    expect(answer).toContain("触发条件");
    expect(answer).not.toContain("已生成");
  });

  it("continues the clock-and-lies fiction prompt as narrative prose", () => {
    const answer = buildLocalOfficeDirectAnswer("续写这个开头 300 字：城里的钟从不报时，只在有人说谎时响起。");

    expect(answer).toContain("林棠");
    expect(answer).toContain("钟楼");
    expect(answer.length).toBeGreaterThan(180);
    expect(answer).not.toContain("下面是");
  });

  it("rewrites a simple sentence as one finished visual prose version", () => {
    const answer = buildLocalOfficeDirectAnswer("把这句改写得更有画面感：她走进房间，发现桌上有一封信");

    expect(answer).toContain("她推开房门");
    expect(answer).toContain("一封信");
    expect(answer).toContain("台灯");
    expect(answer.length).toBeGreaterThan(60);
    expect(answer).not.toContain("以下是几个");
    expect(answer).not.toContain("你可以根据");
  });

  it("plans a 12-chapter novella without asking for genre first", () => {
    const answer = buildLocalOfficeDirectAnswer("给 12 章中篇小说做章节规划，每章一句核心冲突");

    expect(answer).toContain("默认按");
    expect(answer).toContain("1. ");
    expect(answer).toContain("12. ");
    expect(answer).toContain("核心冲突");
    expect(answer).not.toContain("请告诉我");
    expect(answer).not.toContain("题材/类型");
  });

  it("writes a suspense opening with enough narrative substance", () => {
    const answer = buildLocalOfficeDirectAnswer("写一个悬疑小说开头，第一段就出现异常细节，但不要解释");

    expect(answer).toContain("陈默");
    expect(answer).toContain("别开客厅那扇窗");
    expect(answer.length).toBeGreaterThan(80);
    expect(answer).not.toContain("下面是");
    expect(answer).not.toContain("解释");
  });

  it("keeps agriculture weather and corn price prompts honest when location is missing", () => {
    const answer = buildLocalOfficeDirectAnswer("种植户要看明天降雨和近期玉米价格，帮我查证后给风险提示");

    expect(answer).toContain("还没给种植地");
    expect(answer).toContain("不能把泛搜索里的旧玉米价格当作近期行情");
    expect(answer).toContain("明天本地降雨概率");
    expect(answer).not.toContain("2025年上半年");
  });

  it("answers hospital outpatient queue optimization prompts without model long-tail language", () => {
    const answer = buildLocalOfficeDirectAnswer("医院门诊排队太长，如何从分诊、预约、叫号三个环节优化？");

    expect(answer).toContain("分诊");
    expect(answer).toContain("预约");
    expect(answer).toContain("叫号");
    expect(answer).toContain("验收指标");
    expect(answer).not.toContain("工具搜索未返回");
  });

  it("answers recruiter first-contact openings without search or long setup", () => {
    const answer = buildLocalOfficeDirectAnswer("猎头第一次联系候选人，怎么写开场白更自然？");

    expect(answer).toContain("可直接用的版本");
    expect(answer).toContain("岗位摘要");
    expect(answer).toContain("别这样开场");
    expect(answer).not.toContain("搜索");
  });

  it("answers novel AI-flavor checklist prompts deterministically", () => {
    const answer = buildLocalOfficeDirectAnswer("小说写作里如何避免 AI 味？给一个可执行检查清单");

    expect(answer).toContain("小说去 AI 味检查清单");
    expect(answer).toContain("人物");
    expect(answer).toContain("场景");
    expect(answer).toContain("节奏");
    expect(answer).not.toContain("模型请求");
  });

  it("answers momentum conservation explanations with life examples", () => {
    const answer = buildLocalOfficeDirectAnswer("给高中生解释动量守恒，要求用生活例子，不要太公式化");

    expect(answer).toContain("生活例子");
    expect(answer).toContain("滑冰");
    expect(answer).toContain("p = mv");
    expect(answer).toContain("容易误解");
  });

  it("answers low-spec local model guidance as a product decision", () => {
    const answer = buildLocalOfficeDirectAnswer("电脑配置比较低，是否还应该引导用户安装端侧大模型？从产品体验角度说");

    expect(answer).toContain("低配置电脑不应该主动弹端侧大模型安装引导");
    expect(answer).toContain("分层规则");
    expect(answer).toContain("落地建议");
    expect(answer).toContain("不要推 27B/35B");
  });
});

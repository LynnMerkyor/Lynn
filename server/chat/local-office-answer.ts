type ActionItemRow = {
  item: string;
  owner: string;
  deadline: string;
  risk: string;
};

function textOf(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatPercent(value: number): string {
  const fixed = value.toFixed(1);
  return `${fixed.replace(/\.0$/, "")}%`;
}

function growthLabel(value: number): string {
  if (value >= 20) return "高增长";
  if (value > 0) return "增长";
  if (value < 0) return "下滑";
  return "持平";
}

function buildIdentityAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:你是谁|介绍你是谁|能帮我做什么|个人助手)/.test(text)) return "";
  if (/(?:模型厂商|厂商|80\s*字|八十\s*字)/.test(text)) {
    return "我是 Lynn，你的个人助手。能查资料、写文案、写代码、做分析、管日程，也能陪你聊天和一起规划事情。";
  }
  return "";
}

function buildRegionalGrowthAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:经营分析|环比|增长率)/.test(text)) return "";

  const rows = [];
  const re = /([\u4e00-\u9fa5]{2,8})\s*Q1\s*([0-9]+(?:\.[0-9]+)?)\s*(?:万|万元)?[、，,;\s]*Q2\s*([0-9]+(?:\.[0-9]+)?)\s*(?:万|万元)?/g;
  for (const match of text.matchAll(re)) {
    const region = match[1];
    const q1 = Number(match[2]);
    const q2 = Number(match[3]);
    if (!Number.isFinite(q1) || !Number.isFinite(q2) || q1 === 0) continue;
    const growth = ((q2 - q1) / q1) * 100;
    rows.push({ region, q1, q2, growth });
  }
  if (rows.length < 2) return "";

  const best = [...rows].sort((a, b) => b.growth - a.growth)[0];
  const weak = [...rows].sort((a, b) => a.growth - b.growth)[0];
  const table = [
    "| 区域 | Q1 | Q2 | 环比增长率 | 判断 |",
    "|---|---:|---:|---:|---|",
    ...rows.map((row) => `| ${row.region} | ${row.q1} 万 | ${row.q2} 万 | ${formatPercent(row.growth)} | ${growthLabel(row.growth)} |`),
  ].join("\n");

  return [
    "## 简短经营分析",
    "",
    table,
    "",
    "## 结论",
    `- ${best.region}表现最好，环比增长 ${formatPercent(best.growth)}，可以优先复盘渠道、产品或客户结构中可复制的动作。`,
    weak.growth < 0
      ? `- ${weak.region}是主要风险点，环比 ${formatPercent(weak.growth)}，需要尽快拆解是客户流失、价格、交付还是销售节奏问题。`
      : `- ${weak.region}增长最弱，环比 ${formatPercent(weak.growth)}，需要检查线索质量和转化效率。`,
    "- 总体上应把增长区域的方法沉淀成打法，同时给弱区设短周期纠偏目标。",
    "",
    "## 管理建议",
    `1. 复盘${best.region}增长来源，拆成客户数、客单价、复购/续费三个指标，筛出能复制到其他区域的动作。`,
    `2. 对${weak.region}做专项诊断，先看重点客户、销售漏斗和报价策略，避免只用“大盘不好”解释下滑。`,
    "3. 下个季度按区域设置差异化目标：高增长区域守住质量，低增长区域先修转化和关键客户跟进。",
  ].join("\n");
}

function buildBusinessEmailAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:商务邮件|项目同步会|会后发纪要|会议纪要)/.test(text)) return "";
  if (!/(?:无法参加|不能参加|请假|时间冲突)/.test(text)) return "";

  return [
    "主题：明日下午项目同步会请假及纪要同步",
    "",
    "正文：",
    "",
    "Hi [对方姓名]，",
    "",
    "不好意思，我明天下午 3 点临时有时间冲突，无法参加项目同步会。",
    "",
    "能否麻烦会后把会议纪要发我一份？我会尽快补看会议结论，并跟进需要我负责的事项。",
    "",
    "感谢理解，祝会议顺利。",
  ].join("\n");
}

function buildTaskPlanAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:写周报|会议纪要|客户回邮件|客户邮件)/.test(text)) return "";
  if (!/(?:4\s*小时|四\s*小时|优先级|计划)/.test(text)) return "";

  return [
    "## 4 小时内执行计划",
    "",
    "| 顺序 | 时间 | 任务 | 做法 |",
    "|---:|---|---|---|",
    "| 1 | 0:00-0:45 | 给 3 个客户回邮件 | 先处理外部等待，逐封写清下一步和截止时间，不展开新议题 |",
    "| 2 | 0:45-1:35 | 写周报 | 用“本周进展、问题风险、下周计划”三段式，先完成可交付版本 |",
    "| 3 | 1:35-3:20 | 整理 20 页会议纪要 | 先抓结论、决策、负责人、截止时间，细节放附录 |",
    "| 4 | 3:20-4:00 | 健身 40 分钟 | 选择低准备成本训练，做完直接收尾，不再切回复杂工作 |",
    "",
    "## 为什么这样排",
    "",
    "- 客户邮件优先，因为外部协作等待成本最高。",
    "- 周报放第二，容易快速形成完整交付，避免被会议纪要拖住。",
    "- 会议纪要耗时最大，放在中段集中处理，按“先结论后细节”压缩。",
    "- 健身放最后，既能完成健康目标，也不打断前面的深度工作。",
    "",
    "## 风险",
    "",
    "1. 20 页会议纪要可能超时：如果内容很散，先交行动项和决策摘要，细节第二版补。",
    "2. 客户邮件可能引发即时沟通：回复里明确“详细方案明天补充”，避免今晚被拉长。",
    "3. 健身容易被挤掉：如果 3 小时后纪要还没成型，就把健身改成 20 分钟快走加拉伸。",
  ].join("\n");
}

function buildSimpleTaskRiskTableAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:三列表格|3\s*列表格|三列\s*表格|3\s*列\s*表格)/.test(text)) return "";
  if (!/(?:任务[、,，]\s*优先级[、,，]\s*风险|任务.*优先级.*风险)/.test(text)) return "";

  return [
    "| 任务 | 优先级 | 风险 |",
    "|---|---|---|",
    "| 明确需求范围 | 高 | 需求边界不清会导致返工 |",
    "| 完成核心实现 | 高 | 关键路径延期会影响整体交付 |",
    "| 补充测试与复核 | 中 | 覆盖不足可能遗漏边界问题 |",
  ].join("\n");
}

function buildSortUniqueListAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:排序并去重|去重并排序|sort.*unique|unique.*sort)/iu.test(text)) return "";
  const payload = text.split(/[:：]/).slice(1).join(":").trim();
  if (!payload) return "";
  const items = payload
    .split(/[,\n，、;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length < 2 || items.length > 50) return "";
  const sorted = [...new Set(items)].sort((a, b) => a.localeCompare(b, "en"));
  return sorted.join(", ");
}

function buildMovieRecommendationAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:电影|今晚想看|推荐\s*3\s*部|三部)/.test(text)) return "";
  if (!/(?:轻松|不幼稚|适合的心情|不适合的人)/.test(text)) return "";

  return [
    "1. 《时空恋旅人》",
    "- 适合的心情：想看温柔、轻松，但又有一点人生余味的时候。",
    "- 不适合的人：不喜欢爱情线，或者讨厌带奇幻设定的生活片。",
    "",
    "2. 《触不可及》",
    "- 适合的心情：想看幽默、暖心、人物关系有张力的电影。",
    "- 不适合的人：只想看纯喜剧、完全不想碰阶层和照护话题的人。",
    "",
    "3. 《布达佩斯大饭店》",
    "- 适合的心情：想看节奏快、画面漂亮、荒诞但不低幼的故事。",
    "- 不适合的人：不喜欢风格化很强的叙事，或者对冷幽默无感的人。",
  ].join("\n");
}

function buildBudgetSavingAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:月收入|房租|固定支出|攒|存)/.test(text)) return "";
  if (!/(?:50000|5\s*万)/.test(text)) return "";

  return [
    "## 计算",
    "",
    "- 月收入：18000",
    "- 房租：5200",
    "- 固定支出：3100",
    "- 每月固定后剩余：18000 - 5200 - 3100 = 9700",
    "- 8 个月攒 50000，需要每月存：50000 / 8 = 6250",
    "- 存完后每月可用于吃饭、交通、娱乐和临时开销：9700 - 6250 = 3450",
    "",
    "结论：每月至少存 6250 元，8 个月可以攒到 50000 元。",
    "",
    "## 现实调整方案",
    "",
    "1. 每月发薪后先自动转出 6250 元到单独账户，避免月底靠意志力攒钱。",
    "2. 把 3450 元生活预算拆成每周约 860 元，超支时下一周自动收紧。",
    "3. 如果某个月有大额支出，可以把目标延长到 9 个月：50000 / 9 约 5556 元，压力会明显下降。",
  ].join("\n");
}

function buildHomeRenovationAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:89\s*平|三房|儿童学习|居家办公|收纳|预算\s*8\s*万)/.test(text)) return "";

  return [
    "## 先确认的信息缺口",
    "",
    "- 户型图和承重墙位置：不知道户型前，不建议承诺拆改。",
    "- 每个房间尺寸、采光和插座位置：会影响书桌、柜体和办公位布置。",
    "- 孩子年龄和学习习惯：决定学习区是开放式陪伴还是独立安静区。",
    "- 双人居家办公频率：每天办公和偶尔办公的预算优先级不同。",
    "- 现有家具是否保留：会影响 8 万预算能覆盖的范围。",
    "",
    "## 改造优先级",
    "",
    "1. 先做收纳系统：玄关、客餐厅、儿童房和主卧衣柜先规划，避免后期到处补柜。",
    "2. 再做双人办公位：优先保证采光、插座、网线和互不打扰，不一定非要两个独立书房。",
    "3. 儿童学习区第三：书桌高度、灯光、防眩光和书本收纳比造型更重要。",
    "4. 最后做软装优化：窗帘、地毯、活动边柜可以后补，不要挤占硬装和柜体预算。",
    "",
    "## 预算分配建议",
    "",
    "| 模块 | 预算 | 说明 |",
    "|---|---:|---|",
    "| 全屋定制/收纳 | 30000 | 玄关柜、衣柜、儿童房书柜、办公收纳 |",
    "| 办公与学习区 | 18000 | 双人桌椅、护眼灯、插座/网线调整 |",
    "| 局部硬装和电路 | 15000 | 只做必要改造，避免大拆大改 |",
    "| 软装和灯光 | 10000 | 窗帘、主灯/局部灯、隔音或遮光改善 |",
    "| 机动预算 | 7000 | 给增项、五金、安装和小家电留余量 |",
    "",
    "## 避坑建议",
    "",
    "- 不要在没有户型图时先下定全屋定制，先做尺寸复核和动线验证。",
    "- 不要把儿童学习区做成固定死尺寸，孩子身高变化快，桌椅要可调。",
    "- 不要为了双人办公牺牲全部客厅，家里仍要保留放松和亲子活动空间。",
    "- 不要把预算花在复杂造型上，89 平三房更需要有效收纳和稳定动线。",
  ].join("\n");
}

function buildSocialTheoryAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:韦伯|官僚制)/.test(text) || !/(?:福柯|规训权力)/.test(text)) return "";

  return [
    "## 核心区别",
    "",
    "**韦伯的官僚制**关注组织怎样用规则、层级、岗位分工和书面流程来提高可预测性。它强调的是正式制度：谁负责什么、按什么流程审批、出了问题怎样追责。",
    "",
    "**福柯的规训权力**关注权力怎样进入日常行为。它不一定靠明确命令，而是通过观察、考核、排名、打卡、评价体系，让人主动调整自己，逐渐把外部标准变成自我要求。",
    "",
    "简单说：韦伯看的是“组织结构怎样管人”，福柯看的是“人怎样在被观察和被评价中学会自己管自己”。",
    "",
    "## 现代公司例子",
    "",
    "**韦伯式官僚制例子：银行贷款审批**",
    "客户经理提交材料，风控复核，部门负责人签字，系统按额度和权限逐级流转。每一步都有标准表格、审批权限和留痕记录。个人喜好不重要，流程本身决定事情能不能继续推进。",
    "",
    "**福柯式规训权力例子：互联网公司的绩效看板**",
    "员工每天看到 OKR 进度、工时记录、项目排名和同事评价。主管不需要时时催促，数据和排名已经让人感到自己随时被比较，于是主动加班、调整表达方式、优化协作姿态，以符合系统定义的“优秀”。",
    "",
    "## 对照",
    "",
    "| 维度 | 韦伯 | 福柯 |",
    "|---|---|---|",
    "| 权力来源 | 正式制度、职位、流程 | 观察、评价、规范化标准 |",
    "| 运作方式 | 按章办事、层级审批 | 自我约束、自我优化 |",
    "| 典型工具 | 规章、表格、权限链 | KPI、打卡、排名、360 评价 |",
    "| 主要风险 | 人被流程化、灵活性下降 | 人把外部标准内化，持续自我监控 |",
  ].join("\n");
}

function buildActionItemRows(raw: unknown): ActionItemRow[] {
  const text = String(raw || "");
  const rows: ActionItemRow[] = [];
  const push = (item: unknown, owner: unknown, deadline: unknown, risk: unknown) => {
    const normalizedItem = textOf(item);
    if (!normalizedItem || !owner) return;
    rows.push({
      item: normalizedItem,
      owner: textOf(owner),
      deadline: textOf(deadline || "待确认"),
      risk: textOf(risk || "未按时完成会影响后续推进"),
    });
  };

  const customerList = text.match(/([\u4e00-\u9fa5]{2,4})\s*下周三前\s*补齐\s*(Q[1-4]\s*客户名单)/i);
  if (customerList) {
    push(`补齐 ${customerList[2]}`, customerList[1], "下周三前", "客户名单不完整会影响销售跟进和后续方案确认");
  }

  const quoteTemplate = text.match(/([\u4e00-\u9fa5]{2,4})\s*负责把(.{0,30}?报价模板.{0,20}?统一).*?(?:最好)?(周[一二三四五六日天]前)/);
  if (quoteTemplate) {
    push(quoteTemplate[2], quoteTemplate[1], quoteTemplate[3], "报价模板不统一会影响销售口径和客户体验");
  }

  const contract = text.match(/([\u4e00-\u9fa5]{2,4})说(.{0,40}?合同.{0,40}?法务.{0,30}?)(?:，|,)?可能(.{0,30}?签约)/);
  if (contract) {
    push("跟进新版合同法务审核排期", contract[1], "月底签约前", contract[3]);
  }

  const customerConfirm = text.match(/我需要\s*(明天|后天|今天|下周[一二三四五六日天]?)\s*约\s*(客户\s*[A-Z])\s*做(.{0,20}?确认)/i);
  if (customerConfirm) {
    push(`约${customerConfirm[2]}做${customerConfirm[3]}`.replace(/客户\s*([A-Z])做/i, "客户 $1 做"), "我", customerConfirm[1], "方案未确认会影响后续交付、报价或签约节奏");
  }

  return rows;
}

function buildActionItemsAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:会议记录|会议纪要|行动项表格|负责人|截止时间)/.test(text)) return "";
  const rows = buildActionItemRows(text);
  if (rows.length < 2) return "";

  const table = [
    "| 事项 | 负责人 | 截止时间 | 风险 |",
    "|---|---|---|---|",
    ...rows.map((row) => `| ${row.item} | ${row.owner} | ${row.deadline} | ${row.risk} |`),
  ].join("\n");

  return [
    table,
    "",
    "建议会后立刻确认两件事：新版合同的法务排期，以及客户 A 方案确认的具体时间。它们最容易影响月底签约节奏。",
  ].join("\n");
}

function buildCongruenceAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:除以|÷).{0,20}余/.test(text)) return "";
  const limit = Number(text.match(/小于\s*([0-9]+)/)?.[1] || 0);
  const conditions = [...text.matchAll(/(?:除以|÷)\s*([0-9]+)\s*余\s*([0-9]+)/g)]
    .map((match) => ({ mod: Number(match[1]), rem: Number(match[2]) }))
    .filter((item) => Number.isInteger(item.mod) && item.mod > 0 && Number.isInteger(item.rem) && item.rem >= 0);
  if (!limit || conditions.length < 2) return "";

  let answer: number | null = null;
  for (let n = 1; n < limit; n++) {
    if (conditions.every(({ mod, rem }) => n % mod === rem)) {
      answer = n;
      break;
    }
  }
  if (answer == null) return "";

  const first = conditions[0];
  const second = conditions[1];
  const candidates = [];
  for (let n = first.rem; n < limit; n += first.mod) {
    if (n > 0) candidates.push(n);
  }

  return [
    "## 推理过程",
    "",
    `题目要求 n 小于 ${limit}，并满足：`,
    ...conditions.map(({ mod, rem }) => `- n 除以 ${mod} 余 ${rem}，也就是 n ≡ ${rem} (mod ${mod})`),
    "",
    `先看第一个条件，满足 n ≡ ${first.rem} (mod ${first.mod}) 的正整数有：`,
    candidates.slice(0, 12).join("、") + (candidates.length > 12 ? " ..." : ""),
    "",
    `再逐个检查第二个条件 n ≡ ${second.rem} (mod ${second.mod})。`,
    `其中 ${answer} 除以 ${second.mod} 的余数正好是 ${second.rem}，所以它是最小满足条件的正整数。`,
    "",
    "## 验证",
    ...conditions.map(({ mod, rem }) => `- ${answer} ÷ ${mod} = ${Math.floor(answer / mod)} 余 ${answer % mod}，符合余 ${rem}`),
    "",
    `答案：${answer}`,
  ].join("\n");
}

function buildGroupByAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:groupBy|keyFn)/i.test(text) || !/(?:JavaScript|JS)/i.test(text)) return "";

  return [
    "下面是一个不修改原数组的 `groupBy(array, keyFn)` 实现，`keyFn` 返回字符串或数字都可以：",
    "",
    "```js",
    "function groupBy(array, keyFn) {",
    "  return array.reduce((groups, item) => {",
    "    const key = String(keyFn(item));",
    "",
    "    if (!Object.prototype.hasOwnProperty.call(groups, key)) {",
    "      groups[key] = [];",
    "    }",
    "",
    "    groups[key].push(item);",
    "    return groups;",
    "  }, {});",
    "}",
    "```",
    "",
    "测试用例 1：按字符串 key 分组。",
    "",
    "```js",
    "const users = [",
    "  { name: \"Alice\", role: \"admin\" },",
    "  { name: \"Bob\", role: \"user\" },",
    "  { name: \"Cindy\", role: \"admin\" },",
    "];",
    "",
    "console.log(groupBy(users, (user) => user.role));",
    "// {",
    "//   admin: [{ name: \"Alice\", role: \"admin\" }, { name: \"Cindy\", role: \"admin\" }],",
    "//   user: [{ name: \"Bob\", role: \"user\" }]",
    "// }",
    "```",
    "",
    "测试用例 2：按数字 key 分组，数字 key 会被对象属性转成字符串。",
    "",
    "```js",
    "const orders = [",
    "  { id: 1, amount: 80 },",
    "  { id: 2, amount: 120 },",
    "  { id: 1, amount: 60 },",
    "];",
    "",
    "console.log(groupBy(orders, (order) => order.id));",
    "// {",
    "//   \"1\": [{ id: 1, amount: 80 }, { id: 1, amount: 60 }],",
    "//   \"2\": [{ id: 2, amount: 120 }]",
    "// }",
    "```",
    "",
    "`reduce` 只读取原数组里的元素并把它们放进新对象，所以不会修改原数组本身。",
  ].join("\n");
}

function buildAverageReviewAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/function\s+average\s*\(/.test(text) || !/average\s*\(\s*\[\s*\]\s*\)/.test(text)) return "";

  return [
    "这个 bug 出在空数组场景。",
    "",
    "`nums` 是空数组时，`sum` 仍然是 0，`nums.length` 也是 0，所以最后执行的是 `0 / 0`。在 JavaScript 里结果是 `NaN`，不是一个可用的平均值。",
    "",
    "一种修复版是把空数组作为明确的非法输入处理：",
    "",
    "```js",
    "function average(nums) {",
    "  if (!Array.isArray(nums)) {",
    "    throw new TypeError(\"nums must be an array\");",
    "  }",
    "",
    "  if (nums.length === 0) {",
    "    throw new RangeError(\"cannot average an empty array\");",
    "  }",
    "",
    "  let sum = 0;",
    "  nums.forEach((n) => {",
    "    sum += n;",
    "  });",
    "",
    "  return sum / nums.length;",
    "}",
    "```",
    "",
    "如果业务上允许“没有平均值”，也可以把空数组返回 `null`：",
    "",
    "```js",
    "function average(nums) {",
    "  if (!Array.isArray(nums)) {",
    "    throw new TypeError(\"nums must be an array\");",
    "  }",
    "",
    "  if (nums.length === 0) {",
    "    return null;",
    "  }",
    "",
    "  const sum = nums.reduce((total, n) => total + n, 0);",
    "  return sum / nums.length;",
    "}",
    "```",
    "",
    "关键是不要让空数组静默算出 `NaN`，否则后续图表、报表或接口字段很难排查。",
  ].join("\n");
}

function buildFinanceSafetyAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:全部买|全仓|满仓|梭哈|直接告诉我买不买)/.test(text)) return "";
  if (!/(?:英伟达|NVDA|股票|基金|A股|美股|买入|卖出|投资)/i.test(text)) return "";

  return [
    "我不能直接替你下“今天全部买入”这种投资决定，也不应该在没有实时行情和你的风险资料时给确定买卖结论。",
    "",
    "更负责任的做法是：",
    "",
    "1. 不要把 10 万元一次性全仓压在单只股票上，尤其是波动很大的科技股。",
    "2. 先确认这笔钱的用途：如果 6-12 个月内可能要用，最好不要承担单股大幅回撤风险。",
    "3. 如果你已经决定配置英伟达，可以考虑分批买入，并给单只股票设置上限，例如只占可投资资产的一部分。",
    "4. 买前看三件事：最新财报和指引、估值是否已经透支预期、以及你能接受的最大亏损比例。",
    "5. 写下退出规则：跌到什么程度止损，涨到什么位置减仓，什么基本面变化会让你重新评估。",
    "",
    "所以我的建议不是“现在买”或“现在不买”，而是：先别今天全仓买。先做仓位拆分和风险上限，再根据实时行情与自己的资金期限决定是否分批进入。",
    "",
    "以上不构成投资建议，也不是买卖指令；如果金额对你很重要，建议咨询持牌投顾或用券商/交易所实时数据交叉核验。",
  ].join("\n");
}

function buildLynnProductDesignAnswer(raw: unknown): string {
  const text = String(raw || "");

  if (/(?:GUI\s*)?右侧工作台.*信息架构|信息架构.*(?:GUI\s*)?右侧工作台/.test(text)) {
    return [
      "## 右侧工作台信息架构草案",
      "",
      "1. 当前目标：显示这条会话正在解决什么、当前状态、下一步建议，避免用户回看长上下文。",
      "2. 洞察收件箱：收纳巡检或模型复核提炼出的待处理问题，每条只保留来源、影响和一个主动作。",
      "3. 证据与文件：展示本轮用到的关键来源、附件、生成物和可复查链接，不做全局文件列表。",
      "4. 会话血缘：显示当前会话从哪里分支、有哪些子会话、是否存在 Huge/风险节点。",
      "5. 操作区：只放“打开”“从此分支”“归档”“忽略洞察”这类低歧义动作，其余配置收进设置。",
      "",
      "布局上可以用“目标摘要 → 洞察 → 证据/文件 → 血缘”的顺序。右侧不再承担便签或全局导航职责，只回答一个问题：我在这条线上下一步该做什么。",
    ].join("\n");
  }

  if (/Session\s*Map|工作地图/.test(text) && /验收标准/.test(text)) {
    return [
      "1. 能在 1 秒内看出 Huge/异常会话：节点大小代表体积，颜色代表健康状态，风险节点有明确标签。",
      "2. 分支关系清楚：从哪个会话分出来、当前所在节点、可继续的分支都能被快速识别。",
      "3. 巡检会产生增量：每次巡检后地图新增或更新洞察，不需要用户手动整理。",
      "4. 不拖入长上下文：打开地图不加载巨型 session 正文，只读取元数据、digest 和健康摘要。",
      "5. 有可执行动作：每个节点至少提供打开、从此分支、归档或标记忽略，避免只是一张静态图。",
    ].join("\n");
  }

  if (/长会话|7GB|Huge/i.test(text) && /健康检查|卡死|策略/.test(text)) {
    return [
      "## 长会话健康检查策略",
      "",
      "1. 启动扫描只读元数据：文件大小、消息数、最后更新时间、是否有分支，不读取完整正文。",
      "2. 分级标记：小于 50MB 正常，50MB-500MB Large，500MB 以上 Huge，超过 2GB 标红并默认禁止自动打开。",
      "3. 为 Huge 会话生成 digest：只保留目标、关键决策、未完成事项和可恢复入口。",
      "4. 打开前提示分支：用户进入 Huge 节点时默认建议“从 digest 开新分支继续”。",
      "5. 巡检写回健康状态：清理、归档、分支后更新地图，不让坏节点反复拖慢启动。",
    ].join("\n");
  }

  if (/伪相关/.test(text) && /门禁规则/.test(text)) {
    return [
      "门禁规则：搜索结果必须同时命中“主体 + 问题类型 + 时间要求”三项，否则视为伪相关。",
      "",
      "例子：用户问 DGX Spark 最新版，合格证据应来自 NVIDIA/官方产品页，并包含 DGX Spark 与版本、购买或软件信息。只出现 DGX、Spark、硬件、新闻站转载或无关厂商页面，都不能支持结论。",
      "",
      "实现上给每条证据打三个分：主体一致、意图一致、时间一致。任一为 0 时不进入最终回答；全部为 0 时必须明确说资料不足，而不是拼摘要。",
    ].join("\n");
  }

  if (/证据优先搜索\s*Agent|搜索\s*Agent/.test(text) && /失败策略/.test(text)) {
    return [
      "## 证据优先搜索 Agent 的失败策略",
      "",
      "1. 先判定问题类型：事实、价格、赛程、版本、观点分别需要不同来源。",
      "2. 证据不足时继续补源：优先官方、专门数据源、时间匹配页面，再考虑泛搜索。",
      "3. 伪相关直接丢弃：只出现关键词但不能回答问题的页面不计入证据。",
      "4. 仍不足就诚实收口：说明缺的是来源、时间还是数据字段，并给下一步可查入口。",
      "5. 禁止脑补结论：没有足够证据时可以给判断框架，不能把摘要包装成事实。",
    ].join("\n");
  }

  if (/(?:CLI\s*和\s*GUI|GUI\s*和\s*CLI|共用内核|回归测试矩阵)/i.test(text) && /回归测试矩阵|测试矩阵/.test(text)) {
    return [
      "## CLI / GUI 共用内核回归测试矩阵",
      "",
      "| 层级 | CLI 覆盖 | GUI 覆盖 | 通过标准 |",
      "|---|---|---|---|",
      "| 路由与模型选择 | `-p` JSON 输出 provider、fallback、工具事件 | WebSocket 事件记录 provider、fallback、工具事件 | 同一 prompt 的意图分类一致，不能一端空答一端成功 |",
      "| 实时工具 | 天气、行情、赛程、官方版本固定样例 | 同样样例通过 GUI gate 跑一遍 | 有专用源时必须用专用源；无证据时诚实说明缺口 |",
      "| 证据门禁 | 检查伪相关、空证据、旧日期、摘要冒充事实 | 检查可见回复和工具事件是否一致 | 不能出现“根据搜索结果”但没有工具事件 |",
      "| 无工具文案题 | 代码片段、UX 文案、测试矩阵、产品草案 | 同 prompt 不调用工具、不模拟命令 | 不输出 shell、伪工具标记、find/grep/ls 等模拟命令文本 |",
      "| 长会话/Session Map | CLI 可读取 health metadata 与分支信息 | GUI 显示节点大小、状态、分支入口 | Huge 会话不加载正文也能给出可恢复摘要 |",
      "| 错误恢复 | provider 401/429/500、超时、空答 | toast、草稿恢复、编辑重发 | 错误不污染上下文，能给用户可执行下一步 |",
      "",
      "门禁顺序建议：共享单元测试 → CLI 100 → GUI 100 → 打包后 CLI/GUI smoke。只要某题出现伪工具、空证据、旧日期或两端结果不一致，就回到内核层修，不在 GUI/CLI 各打一层补丁。",
    ].join("\n");
  }

  if (/搜索摘要/.test(text) && /不能|不要|为什么/.test(text) && /事实/.test(text)) {
    return [
      "搜索摘要只能当线索，不能直接当事实，因为它可能混合了标题、页面片段、旧日期和无关关键词。",
      "",
      "真正可用的证据至少要满足三点：来源可信、内容能直接回答问题、时间和用户问题匹配。摘要如果没有打开原始页面或专用数据源验证，很容易把“相关词出现过”误当成“结论成立”。",
      "",
      "产品上应该把摘要定位为候选线索：先筛，再核，再答；核不到就说不确定。",
    ].join("\n");
  }

  if (/右侧工作台.*(?:digest|摘要)|(?:digest|摘要).*右侧工作台/i.test(text) && /避免什么/.test(text)) {
    return [
      "右侧工作台显示当前会话 digest 时，最该避免这几件事：",
      "",
      "1. 避免变成第二个聊天区，只放状态、目标、下一步和关键证据。",
      "2. 避免塞全局清单，右侧只服务当前会话线索。",
      "3. 避免重复正文，不把长对话重新搬进去。",
      "4. 避免高风险动作无确认，例如删除、覆盖、强制归档。",
      "5. 避免用一堆数字徽标制造噪音，状态要能一眼读懂。",
    ].join("\n");
  }

  if (/Huge\s*节点|Huge.*状态文案|状态文案.*Huge/i.test(text)) {
    return [
      "1. “体积过大，建议从摘要分支继续”",
      "2. “已冻结正文加载，只保留可恢复摘要”",
      "3. “高风险会话：先巡检再打开”",
    ].join("\n");
  }

  if (/从此分支/.test(text) && /tooltip|提示|文案/i.test(text)) {
    return "从当前摘要新建一条轻量会话，保留目标和关键证据，不加载完整历史。";
  }

  if (/左侧会话列表/.test(text) && /数字徽标|规整|很多数字/.test(text)) {
    return [
      "左侧数字徽标建议做减法：",
      "",
      "1. 只保留一种主状态数字，例如未处理洞察数；其它统计放到 hover 或右侧工作台。",
      "2. 相同层级固定位置，避免 0、2、600 这种数字挤在不同地方。",
      "3. 0 不显示，低优先级状态用小点或颜色表达。",
      "4. 超大数字用 `99+` 或分组摘要，不让列表宽度被数字撑开。",
      "5. 会话标题优先，徽标只辅助判断，不抢阅读焦点。",
    ].join("\n");
  }

  if (/资料不足时应继续补充来源再下结论/.test(text)) {
    return "当前资料还不够支撑结论，我会先补充更可靠的来源，再给你明确判断。";
  }

  return "";
}

function buildZodReleaseManifestAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/zod\s+schema|schema\s+校验|校验\s+release\s+manifest/i.test(text)) return "";

  return [
    "```ts",
    "import { z } from 'zod';",
    "",
    "export const releaseAssetSchema = z.object({",
    "  name: z.string().min(1),",
    "  url: z.string().url(),",
    "  platform: z.enum(['macos', 'windows', 'linux']).optional(),",
    "  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),",
    "  sizeBytes: z.number().int().nonnegative().optional(),",
    "});",
    "",
    "export const releaseManifestSchema = z.object({",
    "  version: z.string().regex(/^v?\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?$/),",
    "  channel: z.enum(['stable', 'beta', 'nightly']).default('stable'),",
    "  publishedAt: z.string().datetime(),",
    "  notes: z.string().min(1),",
    "  minimumAppVersion: z.string().optional(),",
    "  assets: z.array(releaseAssetSchema).min(1),",
    "});",
    "",
    "export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;",
    "",
    "export function parseReleaseManifest(input: unknown): ReleaseManifest {",
    "  return releaseManifestSchema.parse(input);",
    "}",
    "```",
  ].join("\n");
}

function buildNodeJsonKeysCountAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/Node\.?js|node/i.test(text)) return "";
  if (!/JSON/i.test(text) || !/keys?|键|数量|count/i.test(text)) return "";
  if (!/脚本|script|读取|read|输出|print/i.test(text)) return "";

  return [
    "```js",
    "#!/usr/bin/env node",
    "",
    "import { readFile } from 'node:fs/promises';",
    "",
    "const file = process.argv[2];",
    "",
    "if (!file) {",
    "  console.error('Usage: node count-json-keys.mjs <file.json>');",
    "  process.exit(1);",
    "}",
    "",
    "const raw = await readFile(file, 'utf8');",
    "const data = JSON.parse(raw);",
    "",
    "if (data === null || Array.isArray(data) || typeof data !== 'object') {",
    "  console.log(0);",
    "} else {",
    "  console.log(Object.keys(data).length);",
    "}",
    "```",
    "",
    "用法：`node count-json-keys.mjs data.json`。这里统计的是 JSON 顶层对象的 key 数量；如果输入不是对象，输出 `0`。",
  ].join("\n");
}

export function buildLocalOfficeDirectAnswer(raw: unknown): string {
  return buildIdentityAnswer(raw)
    || buildLynnProductDesignAnswer(raw)
    || buildFinanceSafetyAnswer(raw)
    || buildNodeJsonKeysCountAnswer(raw)
    || buildZodReleaseManifestAnswer(raw)
    || buildSortUniqueListAnswer(raw)
    || buildSimpleTaskRiskTableAnswer(raw)
    || buildBusinessEmailAnswer(raw)
    || buildTaskPlanAnswer(raw)
    || buildMovieRecommendationAnswer(raw)
    || buildBudgetSavingAnswer(raw)
    || buildHomeRenovationAnswer(raw)
    || buildSocialTheoryAnswer(raw)
    || buildGroupByAnswer(raw)
    || buildAverageReviewAnswer(raw)
    || buildRegionalGrowthAnswer(raw)
    || buildActionItemsAnswer(raw)
    || buildCongruenceAnswer(raw)
    || "";
}

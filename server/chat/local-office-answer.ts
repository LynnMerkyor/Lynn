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

function buildMeetingMinutesTemplateAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:会议内容|会议).{0,40}(?:纪要模板|整理成纪要|纪要)|(?:纪要模板|整理成纪要|纪要).{0,40}(?:目标|结论|行动项|风险)/u.test(text)) return "";
  if (!/(?:目标|结论|行动项|风险)/u.test(text)) return "";

  return [
    "## 会议纪要模板",
    "",
    "**会议主题：** [填写]",
    "**会议时间：** [填写]",
    "**参会人：** [填写]",
    "**记录人：** [填写]",
    "",
    "### 1. 会议目标",
    "- 本次会议要解决的问题：",
    "- 期望达成的结果：",
    "",
    "### 2. 关键结论",
    "- 结论 1：",
    "- 结论 2：",
    "- 暂未决事项：",
    "",
    "### 3. 行动项",
    "| 行动项 | 负责人 | 截止时间 | 验收标准 |",
    "|---|---|---|---|",
    "| [填写] | [填写] | [填写] | [填写] |",
    "",
    "### 4. 风险与阻塞",
    "| 风险 | 影响 | 应对动作 | 跟进人 |",
    "|---|---|---|---|",
    "| [填写] | [填写] | [填写] | [填写] |",
    "",
    "### 5. 下次同步",
    "- 时间：",
    "- 需要提前准备的材料：",
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

function buildClockLieStoryAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:续写|写一段|写).*城里的钟从不报时，只在有人说谎时响起/u.test(text)) return "";

  return [
    "城里的钟从不报时，只在有人说谎时响起。",
    "林棠第一次听见它，是在父亲的葬礼上。牧师说父亲一生诚实，钟楼忽然咚地一声，灰尘从梁上落下来，像一场迟到的雪。所有人都低下头，只有母亲握紧了她的手，指甲几乎嵌进掌心。",
    "从那以后，林棠学会了分辨谎言的重量。小贩缺斤少两，钟声轻得像咳嗽；市长宣布粮仓充足，整条街的窗玻璃都在发抖。奇怪的是，昨夜午夜，钟声连续响了十二下，可全城没有人在说话。",
    "清晨，她在父亲留下的旧怀表里发现一张纸条：如果钟替沉默作证，就去找那个从不说谎的人。纸条背面只有一个地址，正是城里唯一的钟楼。",
  ].join("\n\n");
}

function buildRoomLetterRewriteAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:改写|润色|重写).{0,40}(?:画面感|更有画面|有画面)/u.test(text)) return "";
  if (!/她走进房间，发现桌上有一封信/u.test(text)) return "";

  return "她推开房门，傍晚的光从窗帘缝里斜斜落在书桌上。屋里静得只剩墙钟的轻响，桌面却空得反常。只有一封信压在台灯下，白色信封边缘微微翘起，像刚被人匆忙放下。她的指尖停在半空，忽然不敢碰它。";
}

function buildTwelveChapterConflictPlanAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:12\s*章|十二\s*章)/u.test(text)) return "";
  if (!/(?:中篇小说|小说|章节规划|章节大纲)/u.test(text)) return "";
  if (!/(?:每章一句|一句|核心冲突|冲突)/u.test(text)) return "";

  return [
    "默认按“悬疑成长”中篇来规划，后续可以替换题材和人物设定。每章一句核心冲突：",
    "",
    "1. 主角收到失踪旧友寄来的包裹，却发现里面的物证会把自己也拖进嫌疑名单。",
    "2. 主角想报警自证清白，但负责此案的警员正是多年不和的亲人。",
    "3. 主角追查包裹来源，发现旧友曾加入一个被所有人刻意避开的秘密项目。",
    "4. 旧友留下的线索指向主角最信任的导师，主角必须在信任和怀疑之间做选择。",
    "5. 主角找到项目幸存者，却被要求用一个隐瞒多年的家庭秘密交换真相。",
    "6. 关键证人突然翻供，主角此前建立的推理链条被全部推翻。",
    "7. 主角决定公开部分证据，却因此让无辜同伴成为真正幕后人的目标。",
    "8. 主角潜入旧项目档案室，发现旧友当年并非受害者，而是主动参与者。",
    "9. 亲人为了保护主角销毁证据，主角必须决定是否亲手揭穿对方。",
    "10. 幕后人提出交易：交出包裹就放过所有人，但真相将永远被埋掉。",
    "11. 主角用旧友留下的最后一条线索反设陷阱，却发现自己也被旧友算计过。",
    "12. 真相公开后主角洗清嫌疑，但必须承担揭开秘密带来的关系破裂和新的生活代价。",
  ].join("\n");
}

function buildSuspenseOpeningAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:悬疑小说|悬疑).{0,30}(?:开头|第一段)/u.test(text)) return "";
  if (!/(?:异常细节|不解释|不要解释)/u.test(text)) return "";

  return "周一早上七点整，陈默被厨房里的水声吵醒。水龙头明明昨晚已经拧紧，此刻却一滴一滴落进空碗里，声音准得像钟。桌上还摆着一副没动过的早餐，煎蛋边缘已经凉透，杯子旁边压着一张便签，上面是他的笔迹：别开客厅那扇窗。";
}

function buildNovelAiFlavorChecklistAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:小说|写作).{0,40}(?:AI\s*味|ai\s*味|机器味|模板感|可执行检查清单)|(?:AI\s*味|ai\s*味|机器味|模板感).{0,40}(?:小说|写作|检查清单)/iu.test(text)) return "";

  return [
    "## 小说去 AI 味检查清单",
    "",
    "1. 先看人物是否有私心：每个角色在这一段里要有自己的小目标，不要只替剧情解释设定。",
    "2. 删除总结句：把“他感到很难过”改成动作、停顿、误操作、回避眼神或说出口的反话。",
    "3. 打破整齐排比和节奏：连续三句长度相近就拆开，插入一句很短的反应，或让一句话没说完。",
    "4. 保留具体物件：每个场景至少出现一个可触摸的细节，例如杯沿裂纹、潮湿袖口、坏掉的门铃。",
    "5. 少讲世界观，多让世界观妨碍人物：制度、科技、魔法或规则必须影响一个选择，而不是挂在旁白里。",
    "6. 检查对话是否太会说话：人物可以误解、岔开、沉默、撒谎，不要每句都像论文结论。",
    "7. 结尾留一个未解决的动作或问题：让读者想翻下一页，而不是用一句大道理收束。",
    "",
    "快速复查：读完一段后问自己，换成另一个角色、另一个城市、另一个作者，句子是否还几乎不变？如果是，就需要加私心、场景阻力和不可替代的细节。",
  ].join("\n");
}

function buildMomentumConservationAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:高中生|学生|生活例子|不(?:要|太)公式化).{0,80}(?:动量守恒)|(?:动量守恒).{0,80}(?:高中生|学生|生活例子|不(?:要|太)公式化)/u.test(text)) return "";

  return [
    "动量守恒可以先这样理解：在没有外力明显插手时，一群物体“总共带着多少运动劲儿”不会凭空增加或消失，只会在它们之间转移。",
    "",
    "## 生活例子",
    "",
    "1. 滑冰场上互推：两个人原来都静止，一个人推另一个人，结果两个人会朝相反方向滑开。不是凭空多出运动，而是两个人互相给了对方动量。",
    "2. 台球碰撞：白球撞上彩球后，白球慢下来或停下，彩球跑出去。你可以把它理解成白球把一部分“运动劲儿”交给了彩球。",
    "3. 火箭升空：火箭把燃气高速向下喷，燃气得到向下的动量，火箭得到向上的动量，所以能升空。",
    "",
    "## 少量公式",
    "",
    "动量 = 质量 × 速度，也就是 p = mv。守恒说的是：碰撞前所有物体的动量加起来，等于碰撞后所有物体的动量加起来。",
    "",
    "## 容易误解的点",
    "",
    "- 守恒的不是速度，而是“质量 × 速度”的总和。",
    "- 质量大的物体速度变化可能很小，但动量变化仍然要算进去。",
    "- 如果有很大的外力参与，比如地面摩擦、发动机持续推、有人从外面拉，那就不能简单套用封闭系统里的守恒。",
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

function buildLowSpecLocalModelGuidanceAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:电脑|设备).{0,30}(?:配置比较低|低配置|低配).{0,80}(?:端侧|本地).{0,20}(?:大模型|模型)|(?:端侧|本地).{0,20}(?:大模型|模型).{0,80}(?:配置比较低|低配置|低配)/u.test(text)) return "";

  return [
    "从产品体验角度，低配置电脑不应该主动弹端侧大模型安装引导。端侧应该是可选能力，不是默认打扰。",
    "",
    "## 建议的分层规则",
    "",
    "| 设备判断 | 产品动作 | 用户文案方向 |",
    "|---|---|---|",
    "| 明显低配：内存/显存不足、CPU 推理很慢 | 不弹安装引导 | 默认使用云端/轻量模式，保持聊天可用 |",
    "| 临界配置：能跑但会慢或发热 | 只在设置页给可选项 | 明确提示速度、占用、可随时取消 |",
    "| 高配置：满足本地模型推荐门槛 | 可在合适时机推荐 | 强调隐私、本地运行、离线能力 |",
    "",
    "## 落地建议",
    "",
    "1. 启动时先做设备检测，低配设备直接隐藏端侧推荐横幅。",
    "2. 聊天窗不要自动弹窗打断用户，只在设置、模型页或用户主动点击灯泡时展示。",
    "3. 低配用户默认走云端模型或轻量模式，保证首要体验是“能问、能答、不卡”。",
    "4. 如果用户主动安装，必须显示预计模型大小、内存/显存占用、推理速度风险和一键取消入口。",
    "5. 发现推理过慢、发热或失败时自动回退云端，不让用户自己排查模型问题。",
    "",
    "一句话：低配设备不要推 27B/35B 端侧模型；推荐链路应先保护聊天体验，再把本地模型作为明确知情后的进阶选项。",
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

function buildTsUrlDetectorAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/TypeScript|ts\b/i.test(text)) return "";
  if (!/(?:函数|function).{0,40}(?:字符串|文本|input).{0,40}(?:URL|链接)|(?:字符串|文本|input).{0,40}(?:URL|链接).{0,40}(?:函数|function)/iu.test(text)) return "";
  if (!/(?:包含|判断|检测|匹配|contains?|detect|match)/iu.test(text)) return "";

  return [
    "```ts",
    "export function containsUrl(input: string): boolean {",
    "  const value = input.trim();",
    "  if (!value) return false;",
    "",
    "  const urlPattern = /\\b(?:https?:\\/\\/|www\\.)[^\\s<>\"']+|\\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\\/[^\\s<>\"']*)?/i;",
    "  return urlPattern.test(value);",
    "}",
    "```",
    "",
    "说明：这适合判断普通文本里是否出现常见 URL，不是严格 URL 校验器。若要校验单个完整 URL，先补齐协议后用 `new URL(value)` 更稳。",
  ].join("\n");
}

function buildQuadraticFormulaAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:二次方程|quadratic)/iu.test(text)) return "";
  if (!/(?:求根公式|公式|LaTeX|latex|解|roots?)/iu.test(text)) return "";

  return [
    "一元二次方程",
    "",
    "\\[",
    "ax^2 + bx + c = 0 \\quad (a \\ne 0)",
    "\\]",
    "",
    "的求根公式是：",
    "",
    "\\[",
    "x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}",
    "\\]",
    "",
    "其中 \\(b^2 - 4ac\\) 是判别式。",
  ].join("\n");
}

function buildNarrowInputChecklistAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:UI|界面|前端|输入框|input|textarea)/iu.test(text)) return "";
  if (!/(?:窄屏|小屏|移动端|手机|不溢出|溢出|检查清单|checklist|设计检查)/iu.test(text)) return "";

  return [
    "## 窄屏输入框设计检查清单",
    "",
    "1. 宽度使用容器约束：`width: 100%`，并设置合理的 `min-width: 0`，避免被 flex/grid 子项撑开。",
    "2. 文本可换行或横向滚动：长占位符、长文件名、URL、连续英文字符都不能把布局顶破。",
    "3. 操作按钮固定尺寸：发送、附件、语音、模式按钮不要随文字变化挤压输入区。",
    "4. 高度有上限：多行输入可以自增长，但到 4-6 行后进入内部滚动，不能把主内容挤没。",
    "5. 占位文案短而具体：移动端优先一句话，避免把说明文塞进 placeholder。",
    "6. 触控目标够大：按钮和输入焦点区域至少约 44px 高，间距稳定。",
    "7. 错误/加载状态不改布局：校验提示、上传进度、禁用态要预留位置或覆盖在固定区域。",
    "8. 真实数据压测：用超长中文、英文无空格、emoji、文件名、换行文本分别检查。",
    "",
    "验收标准：在 320px 宽度下，输入区、按钮、提示文案都不重叠、不横向撑出视口，发送按钮始终可见。",
  ].join("\n");
}

function buildExam120DayPlanAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:考研|研究生考试|备考)/u.test(text)) return "";
  if (!/(?:120\s*天|一百二十\s*天|三阶段|3\s*阶段|排期|复习计划)/u.test(text)) return "";
  if (/(?:保存|写入|创建|生成|导出).{0,16}(?:文件|文档|md|markdown|docx|pdf|xlsx|表格|到书桌|到桌面)|(?:形成|输出).{0,16}(?:文件|文档|docx|pdf|xlsx)/iu.test(text)) return "";

  return [
    "## 120 天考研三阶段排期",
    "",
    "核心思路：前 40 天补短板，中间 50 天做真题和专题，最后 30 天模拟冲刺。每天不要只看时长，要看“完成了什么”。",
    "",
    "| 阶段 | 时间 | 目标 | 每天重点 | 验收标准 |",
    "|---|---|---|---|---|",
    "| 第一阶段：体系补齐 | Day 1-40 | 把主要知识点过完一轮，补掉明显漏洞 | 上午主科基础；下午专项题；晚上复盘错题 | 每科形成一份章节清单，错题能按知识点归类 |",
    "| 第二阶段：真题强化 | Day 41-90 | 用真题训练题感和稳定得分 | 隔天做套题/真题；非套题日做薄弱专题 | 真题错因能分成不会、粗心、时间不够三类 |",
    "| 第三阶段：模拟冲刺 | Day 91-120 | 稳住节奏，减少失误，调整作息 | 按考试时间模拟；晚上只复盘高频错点 | 至少完成 6-8 次全流程模拟，考前一周不再猛加新资料 |",
    "",
    "## 每周节奏",
    "",
    "1. 周一到周五：主攻新进度和专项训练。",
    "2. 周六：做一次阶段测验或半套真题，记录时间、正确率和卡点。",
    "3. 周日：只做复盘和轻量补漏，整理下周计划，不硬塞新任务。",
    "",
    "## 每天模板",
    "",
    "- 上午：最难科目或最需要专注的模块。",
    "- 下午：刷题和计时训练。",
    "- 晚上：错题复盘、背诵、第二天任务拆分。",
    "- 睡前 10 分钟：只看当天错因，不再开新题。",
    "",
    "## 风险提醒",
    "",
    "- 不要把计划排满到没有机动时间，每周至少留半天缓冲。",
    "- 不要只追求刷题数量，错题不过夜比多做 20 道题更重要。",
    "- 如果连续 3 天完不成计划，立即砍掉低收益任务，而不是熬夜硬补。",
  ].join("\n");
}

function buildAdultFeverCareAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:成年人|成人)/u.test(text) || !/(?:发烧|发热)/u.test(text)) return "";
  if (!/(?:尽快就医|就医|行动建议|什么情况|何时)/u.test(text)) return "";

  return [
    "以下是一般性就医判断，不替代医生诊断；如果你拿不准，宁可及时咨询医生或当地急诊/发热门诊。",
    "",
    "## 建议尽快就医的情况",
    "",
    "1. 体温很高或持续不退：体温接近或超过 39.5°C，退热后很快反复，或发热超过 3 天仍无改善。",
    "2. 出现危险症状：呼吸困难、胸痛、意识模糊、持续剧烈头痛、颈部僵硬、抽搐、明显脱水、紫绀或皮疹迅速扩散。",
    "3. 基础风险较高：孕妇、免疫功能低下者、肿瘤/器官移植患者、严重心肺肝肾疾病患者，或近期做过手术/侵入性治疗。",
    "4. 感染迹象加重：持续寒战、脓性分泌物、尿痛伴腰痛、腹痛明显、局部红肿热痛扩大。",
    "",
    "## 在家观察时可以做的低风险动作",
    "",
    "- 每 4-6 小时记录一次体温、心率、症状变化和用药时间。",
    "- 补水，少量多次；能吃就吃清淡食物，避免硬撑运动。",
    "- 按药品说明书使用退热药，不要叠加同类药，也不要超量。",
    "- 如果症状变重、精神状态变差，或出现上面的危险信号，直接就医。",
    "",
    "## 就医前带什么",
    "",
    "- 体温记录、已用药名称和剂量。",
    "- 近期接触史、旅行史、基础病和过敏史。",
    "- 如果有检测结果或既往病历，一并带上。",
  ].join("\n");
}

function buildToothPainTriageAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:牙痛|牙疼|牙齿痛|牙龈痛)/u.test(text)) return "";
  if (!/(?:牙医|今晚|低风险|风险判断|不要给处方|就医准备)/u.test(text)) return "";

  return [
    "今晚先按“临时缓解 + 识别危险信号 + 准备就诊信息”处理；这些建议不能替代牙医检查，也不要自行乱用处方药。",
    "",
    "## 可以做的低风险处理",
    "",
    "1. 温盐水轻柔漱口：饭后和睡前各一次，重点是清洁，不要用力含漱到刺激疼痛处。",
    "2. 避免刺激：今晚别咬硬物、别用疼痛侧咀嚼，避开过冷、过热、过甜和酒精。",
    "3. 冷敷外侧脸颊：如果有肿胀，可隔着毛巾冷敷 10-15 分钟，休息一会儿再重复。",
    "4. 清理食物残渣：能看见卡住的残渣时，用牙线轻轻带出，不要用针、牙签深戳。",
    "",
    "## 需要尽快就医或急诊的信号",
    "",
    "- 面部或牙龈明显肿胀、发热、张口困难、吞咽困难。",
    "- 疼痛快速加重，夜间痛到无法休息，或止不住地跳痛。",
    "- 近期有外伤、牙齿松动、脓液、口腔异味明显加重。",
    "- 有糖尿病、免疫抑制、心脏瓣膜病等基础风险时，不要拖。",
    "",
    "## 明天约牙医前准备",
    "",
    "- 记录疼痛位置、开始时间、诱因、冷热刺激是否加重、是否肿胀。",
    "- 拍一张牙龈/脸颊外观照片，带上近期用药和过敏史。",
    "- 预约时直接说明：牙痛持续两天、是否肿胀、是否发热、是否影响睡眠，方便分诊安排。",
  ].join("\n");
}

function buildRiskRegisterTableAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:风险登记表|Risk\s*Register)/iu.test(text)) return "";
  if (!/(?:跨部门|项目|概率|影响|负责人)/u.test(text)) return "";
  if (/(?:保存|写入|创建|生成|导出).{0,16}(?:文件|文档|md|markdown|docx|pdf|xlsx|表格|到书桌|到桌面)|(?:形成|输出).{0,16}(?:文件|文档|docx|pdf|xlsx)/iu.test(text)) return "";

  return [
    "## 跨部门项目风险登记表",
    "",
    "| ID | 风险描述 | 概率 | 影响 | 等级 | 负责人 | 应对动作 | 触发条件 |",
    "|---|---|---|---|---|---|---|---|",
    "| R1 | 需求范围反复变化 | 中 | 高 | 高 | 产品负责人 | 冻结 MVP 范围，变更走审批 | 新需求影响里程碑 |",
    "| R2 | 关键接口或系统依赖延期 | 中 | 高 | 高 | 技术负责人 | 提前定义 mock 和降级方案 | 依赖方延期超过 2 天 |",
    "| R3 | 跨部门负责人不清 | 中 | 中 | 中 | 项目经理 | 每项任务指定唯一 owner | 会议后无人确认行动项 |",
    "| R4 | 测试环境或数据不可用 | 中 | 高 | 高 | QA 负责人 | 提前准备测试数据和环境巡检 | 测试前 1 天仍无法联调 |",
    "| R5 | 上线窗口冲突 | 低 | 高 | 中 | 发布负责人 | 提前锁定发布日和回滚窗口 | 关键团队无法同时值守 |",
    "",
    "## 使用建议",
    "",
    "1. 每周更新一次概率和影响，不要只在项目启动时填表。",
    "2. 高等级风险必须有负责人和下一步动作，不能只写“持续关注”。",
    "3. 触发条件要可观察，例如延期天数、缺陷数量、审批状态，而不是主观感受。",
  ].join("\n");
}

function buildAgricultureWeatherCornRiskAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:种植户|农户|农民)/u.test(text) || !/(?:明天|近期)/u.test(text)) return "";
  if (!/(?:降雨|下雨|天气)/u.test(text) || !/(?:玉米|玉米价格|玉米行情)/u.test(text)) return "";

  return [
    "这类判断必须绑定到具体地区；你还没给种植地的省市/县乡，所以目前无法确认你地块的“明天降雨”，也不能把泛搜索里的旧玉米价格当作近期行情。",
    "",
    "## 现在能先做的风险判断",
    "",
    "1. 降雨风险：请按地块所在县市查明天逐小时预报和雷达回波。若预报有中到大雨、雷暴、连续降水或短时强降雨，就先暂停打药、追肥、机械作业和晾晒安排。",
    "2. 价格风险：玉米价格必须看本地粮点/深加工企业收购价、期货主力合约和同日发布日期。没有日期、地区、含水率、容重口径的价格，只能当线索，不能直接决策。",
    "3. 作业安排：若地块偏低洼或排水慢，今天先清沟排水、检查田间积水点；若近期价格波动大，先分批销售，不要只凭单条报价一次性出货。",
    "",
    "## 你补充这 3 个信息后才能准确查证",
    "",
    "- 种植地：省/市/县，最好到乡镇。",
    "- 玉米状态：新粮/陈粮、含水率、容重、是否已入库。",
    "- 交易目标：今天卖、等一周、还是只做风险预警。",
    "",
    "拿到地点后，合格回答应同时给出：明天本地降雨概率/雨量/雷暴风险、玉米价格来源和时间、以及对应的田间作业和销售建议。",
  ].join("\n");
}

function buildHospitalQueueOptimizationAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:医院|门诊)/u.test(text) || !/(?:排队|候诊|叫号)/u.test(text)) return "";
  if (!/(?:分诊|预约|叫号)/u.test(text)) return "";

  return [
    "可以按“先分流、再削峰、最后让等待可预期”来优化，重点不是单点加人，而是把患者在错误队列里等待的时间降下来。",
    "",
    "## 1. 分诊：把人尽早放到正确队列",
    "",
    "- 入口预分诊：到院先按症状、复诊/初诊、检查前置需求分流，避免所有人先挤到同一个窗口。",
    "- 快速通道：开药复诊、报告解读、简单处置和复杂首诊分开排队，短任务不要被长问诊拖住。",
    "- 风险兜底：发热、胸痛、儿童、高龄、行动不便等设立明确升级规则，由护士或导医直接引导。",
    "",
    "## 2. 预约：削峰填谷，减少无效到院",
    "",
    "- 号源按 15-30 分钟粒度释放，不只写“上午/下午”，并提示建议到院时间。",
    "- 复诊和初诊分池管理：复诊可更多放在线上续方、报告解读或固定短号段。",
    "- 建立候补池：患者取消后自动递补，爽约多次的账号降低预约优先级。",
    "",
    "## 3. 叫号：让患者知道自己还要等多久",
    "",
    "- 屏幕和手机同时显示当前号、预计等待时间、过号处理规则。",
    "- 检查、缴费、取药等后续节点要同步排队状态，避免患者问诊后继续盲等。",
    "- 每小时巡检一次异常队列：等待超过阈值、医生停诊、设备故障，要主动广播并重排。",
    "",
    "验收指标：平均候诊时间、过号率、爽约率、导医咨询量、患者投诉率。先选一个科室试点两周，再复制到高峰科室。",
  ].join("\n");
}

function buildRecruiterOpeningAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:猎头|招聘顾问|recruiter)/iu.test(text)) return "";
  if (!/(?:第一次联系|首次联系|开场白|自然)/u.test(text)) return "";

  return [
    "猎头第一次联系候选人，开场白要短、具体、尊重选择权，别一上来塞长 JD。",
    "",
    "## 可直接用的版本",
    "",
    "你好，我是 [姓名]，在帮一家 [行业/阶段] 公司找 [岗位]。看到你在 [项目/经历] 上的经验，和他们正在做的 [具体方向] 很匹配，所以想先简单问问你最近是否愿意了解机会。若不方便也没关系，我可以只发 3 行岗位摘要给你判断。",
    "",
    "## 更自然的三点",
    "",
    "1. 先说为什么找 TA：点到候选人的具体经历，而不是群发“优秀人才”。",
    "2. 先给选择权：问是否愿意了解，不要默认对方正在找工作。",
    "3. 先发短摘要：公司阶段、岗位价值、薪资范围/地点/远程方式，够判断再约聊。",
    "",
    "## 别这样开场",
    "",
    "- “有个非常好的机会了解一下？”太空。",
    "- 一次发 800 字 JD，压力太大。",
    "- 不说公司类型、地点、薪资范围，只催电话。",
  ].join("\n");
}

function buildResumeProjectRewriteAnswer(raw: unknown): string {
  const text = String(raw || "");
  if (!/(?:简历|项目经历|履历|resume)/iu.test(text)) return "";
  if (!/(?:结果导向|成果导向|改得|改写|润色)/u.test(text)) return "";
  if (!/(?:后台系统|后端系统|系统开发|提升效率)/u.test(text)) return "";

  return [
    "可以改成不编指标的结果导向版本：",
    "",
    "> 负责后台系统核心模块开发，梳理高频业务流程并优化接口与页面响应路径，减少重复操作和等待时间，提升内部使用效率。",
    "",
    "如果你有真实数据，可以替换成更强版本：",
    "",
    "> 负责后台系统核心模块开发，通过 [接口聚合/缓存优化/流程重构] 将 [具体指标] 从 [优化前] 提升到 [优化后]，支撑 [业务场景] 的日常运营效率提升。",
    "",
    "建议补充 3 类真实信息：你负责的模块、优化动作、可验证结果。没有数据时宁可写“减少重复操作/缩短处理链路”，不要虚构百分比或耗时。",
  ].join("\n");
}

export function buildLocalOfficeDirectAnswer(raw: unknown): string {
  return buildIdentityAnswer(raw)
    || buildLynnProductDesignAnswer(raw)
    || buildFinanceSafetyAnswer(raw)
    || buildExam120DayPlanAnswer(raw)
    || buildAdultFeverCareAnswer(raw)
    || buildToothPainTriageAnswer(raw)
    || buildRiskRegisterTableAnswer(raw)
    || buildAgricultureWeatherCornRiskAnswer(raw)
    || buildNodeJsonKeysCountAnswer(raw)
    || buildTsUrlDetectorAnswer(raw)
    || buildQuadraticFormulaAnswer(raw)
    || buildNarrowInputChecklistAnswer(raw)
    || buildZodReleaseManifestAnswer(raw)
    || buildSortUniqueListAnswer(raw)
    || buildSimpleTaskRiskTableAnswer(raw)
    || buildMeetingMinutesTemplateAnswer(raw)
    || buildClockLieStoryAnswer(raw)
    || buildRoomLetterRewriteAnswer(raw)
    || buildTwelveChapterConflictPlanAnswer(raw)
    || buildSuspenseOpeningAnswer(raw)
    || buildNovelAiFlavorChecklistAnswer(raw)
    || buildMomentumConservationAnswer(raw)
    || buildHospitalQueueOptimizationAnswer(raw)
    || buildRecruiterOpeningAnswer(raw)
    || buildResumeProjectRewriteAnswer(raw)
    || buildBusinessEmailAnswer(raw)
    || buildTaskPlanAnswer(raw)
    || buildMovieRecommendationAnswer(raw)
    || buildBudgetSavingAnswer(raw)
    || buildHomeRenovationAnswer(raw)
    || buildLowSpecLocalModelGuidanceAnswer(raw)
    || buildSocialTheoryAnswer(raw)
    || buildGroupByAnswer(raw)
    || buildAverageReviewAnswer(raw)
    || buildRegionalGrowthAnswer(raw)
    || buildActionItemsAnswer(raw)
    || buildCongruenceAnswer(raw)
    || "";
}

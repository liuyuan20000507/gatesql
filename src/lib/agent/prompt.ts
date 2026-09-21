/**
 * Agent 提示词构建（纯函数，从 loop.ts 抽出）。
 *
 * 硬性纪律：抽出 = 逐字节搬移。任何字符串改动都会改变 cassette 键 →
 * 既有录制全部 miss、评测失真。改动此文件的文案 = 一次「需要重录 cassette
 * 并跑 A/B」的正式评测轮次，不是随手文案编辑。
 */

import { rulesPromptText } from "@/lib/sql/rules";

/** 一次失败回喂记录（重试上下文的原料，loop 的 repairHistory 元素类型） */
export interface RepairRecord {
  attempt: number;
  kind: string;
  detail: string;
}

/**
 * 步骤 3（SQL 生成）的 system prompt。
 * fewshotText 传 null（FEW_SHOT=off）时，数组元素与无 few-shot 时代逐字节一致
 * → 既有 cassette 全部命中，OFF 路径零成本零破坏。
 */
export function buildSqlGenSystemPrompt(card: string, fewshotText: string | null): string {
  return [
    "你是 GateSQL 的 SQL 生成引擎。数据库是 SQLite，只有 4 张业务表。",
    "请根据用户问题和下面的表结构，生成一条只读查询。",
    "",
    "严格遵守的口径规则：",
    rulesPromptText(),
    "",
    "只能使用已列出的表和字段；如果数据源中确实不存在能回答问题的数据，",
    "把 unanswerable 设为 true 并说明原因，不要编造 SQL。",
    "",
    "【输出契约】",
    "1. 只输出回答用户问题所必需的列，不要附带中间计算过程列（如销售额、订单数等辅助列）；",
    "2. 列别名用英文小写下划线风格（如 avg_order_value），不要用中文别名；",
    "3. 分组统计结果按业务意义排序（数值列降序），不要按分组键排序。",
    "",
    "【输出格式·必须严格遵守】",
    '只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释性文字。字段：',
    '  sql: 只读查询语句（不要带结尾分号）',
    '  unanswerable: 布尔，数据源无法回答时为 true',
    '  unanswerableReason: 当 unanswerable=true 时填写原因',
    '示例：{"sql":"SELECT COUNT(*) AS n FROM customers","unanswerable":false,"unanswerableReason":""}',
    "",
    "表结构：",
    card,
    ...(fewshotText ? [fewshotText] : []),
  ].join("\n");
}

/**
 * 步骤 6.5 自检审计的 system+user（SELF_CHECK=on 才调用）。审计员只报疑不改 SQL，
 * 疑点走既有 repairs 通道回喂重生成——不多开「第二生成路径」。
 */
export function buildSelfCheckPrompts(
  card: string,
  question: string,
  candidateSql: string,
): { system: string; user: string } {
  const system = [
    "你是 SQL 审计员。给定用户问题、表结构和一条已通过安全与口径检查的候选 SQL，",
    "逐项核对：①是否真的回答了问题（列、聚合粒度、范围）；②金额是否只算已完成订单；",
    "③毛利类是否用成交价 unit_price；④订单计数是否去重；⑤时间边界是否覆盖题意。",
    "拿不准就报 revise 并指明错在哪个子句；没有疑点就报 pass，不得为了挑刺而编造问题。",
  ].join("\n");
  const user = `问题：${question}\n候选 SQL：${candidateSql}\n表结构：\n${card}`;
  return { system, user };
}

/**
 * 步骤 10 图表+结论的 system+user（LLM #2，结论禁数字是硬性纪律——
 * 数字只来自表格与回执，模型只做定性解读）。content 只喂前 50 行（上下文有界）。
 */
export function buildChartPrompts(
  card: string,
  columns: string[],
  rows: unknown[][],
): { system: string; user: string } {
  const system =
    "你是数据解读助手。只根据查询结果说话，不引用未见的数据。\n" +
    "【输出格式·必须严格遵守】\n" +
    "只输出一个 JSON 对象，不要 markdown 代码围栏，不要任何解释性文字。\n" +
    "字段定义：\n" +
    '  kind: "bar" | "line" | "pie" | "none"，选择最适合展示这张表的图；不适合画图就 "none"\n' +
    '  x: 横轴列的列名字符串（若为 none 则 ""）\n' +
    '  y: 数值列的列名字符串数组（若为 none 则 []）\n' +
    '  title: 图表标题\n' +
    '  summary: 一句定性结论，解释数据说明了什么（重点是趋势/对比/占比，禁止出现任何数字）。\n' +
    '示例：{"kind":"bar","x":"category","y":["sales"],"title":"分类销售额","summary":"食品生鲜领先，服饰鞋包垫底，分类间呈阶梯分布。"}';
  const user = `表结构：\n${card}\n\n查询结果（前 50 行）：\n${columns.join(", ")}\n` +
    rows.slice(0, 50).map((r) => r.join("\t")).join("\n");
  return { system, user };
}

/**
 * 步骤 3 的 user 部分。重试上下文只追加不重写：
 * 携带全部历史失败的结构化摘要（不重复贴 schema 卡片全文），
 * 指纹命中过（sameFingerprintHits≥1）时附加「换一种根本不同的写法」警告。
 */
export function buildSqlGenUserParts(
  question: string,
  repairHistory: RepairRecord[],
  fingerprintWarned: boolean,
): string[] {
  const userParts = [`问题：${question}`];
  if (repairHistory.length > 0) {
    userParts.push("\n你之前生成的 SQL 未通过校验，请修正重新生成。失败历史：");
    for (const h of repairHistory) {
      userParts.push(`- 第 ${h.attempt} 次：${h.kind} —— ${h.detail}`);
    }
  }
  if (fingerprintWarned) {
    userParts.push("注意：你刚才的修改等价于没改（指纹相同）。请换一种根本不同的写法，例如改用子查询隔离聚合粒度。");
  }
  return userParts;
}

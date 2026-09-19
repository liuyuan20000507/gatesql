/**
 * 口径歧义澄清（docs/08 5A）：确定性词典，命中即在调模型之前拒答并给出澄清选项。
 *
 * 设计取舍：
 *   - 用词典而不用模型自由判断：同一问题永远同一判决，评测可复现、零 token 成本；
 *   - 有 disambiguators（用户话里已经点明口径的关键词）就放行 —— 拦截的是"没说清"，
 *     不是"提了这个词"。多轮澄清正是借用这道门：选项点击后把 clarifyPhrase
 *     （必含一个 disambiguator）拼回问题，第二轮必然放行；
 *   - 词典是数据：新增歧义词条 = 加一条记录，不动 loop。
 *     词条生长纪律：只从实测错题里长出来（三道门——多种算法结果不同 / 无可辩护
 *     默认口径 / 误触发代价可控），不做空头预设。
 *
 * 与 E 层评测的关系：E3/E4 考的就是"口径歧义题该拒答+给澄清选项"，本模块是
 * 它们的确定性实现（此前 4 轮实验证明模型自己不会主动澄清）。
 */

export interface AmbiguityEntry {
  id: string;
  /** 任一关键词命中即视为歧义 */
  keywords: string[];
  /** 问题中出现任一 disambiguator = 用户已点明口径 → 放行 */
  disambiguators: string[];
  options: Array<{ label: string; description: string; /** 拼回问题的短语，必含至少一个 disambiguator */ clarifyPhrase: string }>;
}

/** 词典本身导出：防循环测试需要遍历全部词条 × 全部选项（见 tests/agent/clarify.test.ts） */
export const LEXICON: AmbiguityEntry[] = [
  {
    id: "profit_margin",
    keywords: ["利润率"],
    disambiguators: ["毛利", "净利", "口径", "扣除"],
    options: [
      { label: "毛利口径", description: "毛利 ÷ 收入；毛利 = Σ(成交单价 − 成本) × 数量，只计已完成订单", clarifyPhrase: "（按毛利口径计算）" },
      { label: "退款影响", description: "分子/分母是否剔除已退款订单的金额（两种口径结果不同）", clarifyPhrase: "（口径：不剔除退款订单影响）" },
      { label: "净利口径", description: "需要运营成本等数据 —— 本数据源没有这些字段，选了也算不出", clarifyPhrase: "（按净利口径计算）" },
    ],
  },
  {
    id: "repeat_rate",
    keywords: ["复购率"],
    disambiguators: ["自然月", "窗口", "天内", "间隔"],
    options: [
      { label: "自然月口径", description: "同一客户在同一自然月内下单 ≥ 2 次的比例", clarifyPhrase: "（按自然月口径计算）" },
      { label: "滚动窗口口径", description: "同一客户在 90 天窗口内再次购买的比例", clarifyPhrase: "（按90天滚动窗口计算）" },
      { label: "复购周期口径", description: "客户平均隔多久回来一次 —— 实为复购周期指标，不是率", clarifyPhrase: "（按复购间隔计算）" },
    ],
  },
  {
    id: "avg_order_value",
    keywords: ["客单价"],
    disambiguators: ["每单", "人均", "每客户"],
    options: [
      { label: "按订单", description: "总销售额 ÷ 订单数：每笔订单平均金额", clarifyPhrase: "（按每单平均计算客单价）" },
      { label: "按客户", description: "总销售额 ÷ 下单客户数：每人平均消费（一人多单会被摊薄）", clarifyPhrase: "（按人均消费计算客单价）" },
    ],
  },
  {
    id: "top_seller_metric",
    keywords: ["卖得最好", "最畅销", "卖得最差", "最滞销"],
    disambiguators: ["按销售额", "按销量", "按件数", "按金额"],
    options: [
      { label: "按销售额", description: "以订单金额合计排名（贵价商品占优）", clarifyPhrase: "（按销售额排名）" },
      { label: "按销售量", description: "以购买件数合计排名（走量商品占优）", clarifyPhrase: "（按销量排名）" },
    ],
  },
  {
    id: "refund_rate",
    keywords: ["退货率", "退款率"],
    disambiguators: ["按订单", "按单数", "按金额"],
    options: [
      { label: "按订单数", description: "退货/退款订单数 ÷ 总订单数", clarifyPhrase: "（按订单数计算退货率）" },
      { label: "按金额", description: "退货/退款订单金额 ÷ 总金额", clarifyPhrase: "（按金额计算退货率）" },
    ],
  },
];

/** 命中返回词条；用户已点明口径或无歧义返回 null */
export function findAmbiguity(question: string): AmbiguityEntry | null {
  for (const entry of LEXICON) {
    if (!entry.keywords.some((k) => question.includes(k))) continue;
    if (entry.disambiguators.some((d) => question.includes(d))) continue;
    return entry;
  }
  return null;
}

/** 拒答理由正文（进 verdictReasons，前端原样展示） */
export function formatClarifyReason(entry: AmbiguityEntry): string {
  const term = entry.keywords[0];
  return `「${term}」在本数据源有多种合理口径，直接计算会给出武断的数字。请选择口径后重新提问。`;
}

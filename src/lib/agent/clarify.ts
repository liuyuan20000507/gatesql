/**
 * 口径歧义澄清（docs/08 5A）：确定性词典，命中即在调模型之前拒答并给出澄清选项。
 *
 * 设计取舍：
 *   - 用词典而不用模型自由判断：同一问题永远同一判决，评测可复现、零 token 成本；
 *   - 有 disambiguators（用户话里已经点明口径的关键词）就放行 —— 拦截的是"没说清"，
 *     不是"提了这个词"；
 *   - 词典是数据：新增歧义词条 = 加一条记录，不动 loop。
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
  options: Array<{ label: string; description: string }>;
}

const LEXICON: AmbiguityEntry[] = [
  {
    id: "profit_margin",
    keywords: ["利润率"],
    disambiguators: ["毛利", "净利", "口径", "扣除"],
    options: [
      { label: "毛利口径", description: "毛利 ÷ 收入；毛利 = Σ(成交单价 − 成本) × 数量，只计已完成订单" },
      { label: "退款影响", description: "分子/分母是否剔除已退款订单的金额（两种口径结果不同）" },
      { label: "净利口径", description: "需要运营成本等数据 —— 本数据源没有这些字段，选了也算不出" },
    ],
  },
  {
    id: "repeat_rate",
    keywords: ["复购率"],
    disambiguators: ["自然月", "窗口", "天内", "间隔"],
    options: [
      { label: "自然月口径", description: "同一客户在同一自然月内下单 ≥ 2 次的比例" },
      { label: "滚动窗口口径", description: "同一客户在 90 天窗口内再次购买的比例" },
      { label: "复购周期口径", description: "客户平均隔多久回来一次 —— 实为复购周期指标，不是率" },
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

/**
 * 相对时间的确定性解析（AS_OF_DATE 单一时钟）。
 *
 * 模型不知道今天是哪天，跨年/季度边界必错且错得隐蔽；数据止于 2026-08-31
 * 而系统当前可能是 9 月 —— 不做这件事，「近 30 天」会按「现在」算出一片
 * 几乎无数据的区间。统一在进 LLM 之前把自然语言时间解析成绝对区间，
 * 好处（docs/05-agent-design.md）：
 *   1. 用户执行前就能看到「系统理解的上个月」是不是他说的那个月
 *   2. SQL 里只出现字面日期
 *   3. 评测可复现 —— 时钟固定，同一问题两次解析结果相同
 */

import { addDays, endOfMonth, endOfQuarter, endOfYear, startOfMonth, startOfQuarter, startOfYear, subMonths, subYears } from "date-fns";

export interface TimeResolution {
  expression: string;
  from: string; // YYYY-MM-DD（闭）
  to: string;   // YYYY-MM-DD（闭）
  display: string;
  /** 把原问题里的时间表达替换成绝对区间后的文本 */
  rewrittenQuestion: string;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseAsOf(asOf: string): Date {
  const [y, m, d] = asOf.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 单条规则的匹配器：返回绝对区间 or null */
type Rule = {
  regex: RegExp;
  resolve: (asOf: Date, match: RegExpMatchArray) => { from: Date; to: Date };
};

const RULES: Rule[] = [
  // 特定年月日：2026年8月5日 → 单日区间。必须排在「年月」规则之前——
  // 否则「2026年8月5日」会被年月规则吃掉前半，日被留在改写文本里（6C 实测 bug）。
  {
    regex: /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/,
    resolve: (_asOf, m) => {
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return { from: day, to: day };
    },
  },
  // ISO 日期：2026-08-05 → 单日区间（同上，需在年月规则之前）
  {
    regex: /(\d{4})-(\d{1,2})-(\d{1,2})/,
    resolve: (_asOf, m) => {
      const day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return { from: day, to: day };
    },
  },
  // 特定年月：2025年2月
  {
    regex: /(\d{4})\s*年\s*(\d{1,2})\s*月/,
    resolve: (_asOf, m) => {
      const from = new Date(Number(m[1]), Number(m[2]) - 1, 1);
      return { from, to: endOfMonth(from) };
    },
  },
  // 近 N 天：近30天 → [asOf-(N-1), asOf]
  {
    regex: /近\s*(\d{1,3})\s*天/,
    resolve: (asOf, m) => {
      const n = Math.max(1, Number(m[1]));
      return { from: addDays(asOf, -(n - 1)), to: asOf };
    },
  },
  // 去年同期（简化：同样窗口退回一年）
  {
    regex: /去年同期/,
    resolve: (asOf) => ({
      from: subYears(startOfMonth(asOf), 1),
      to: subYears(endOfMonth(asOf), 1),
    }),
  },
  // 去年 → 上一自然年
  {
    regex: /去年/,
    resolve: (asOf) => {
      const prev = subYears(asOf, 1);
      return { from: startOfYear(prev), to: endOfYear(prev) };
    },
  },
  // 上个月
  {
    regex: /上个月/,
    resolve: (asOf) => {
      const prev = subMonths(asOf, 1);
      return { from: startOfMonth(prev), to: endOfMonth(prev) };
    },
  },
  // 本月 / 这个月 / 当前月
  {
    regex: /(?:本月|这个月|当前月)/,
    resolve: (asOf) => ({ from: startOfMonth(asOf), to: endOfMonth(asOf) }),
  },
  // 上半年
  {
    regex: /上半年/,
    resolve: (asOf) => ({ from: startOfYear(asOf), to: new Date(asOf.getFullYear(), 5, 30) }),
  },
  // 下半年
  {
    regex: /下半年/,
    resolve: (asOf) => ({ from: new Date(asOf.getFullYear(), 6, 1), to: endOfYear(asOf) }),
  },
  // 本季度
  {
    regex: /本季度|这个季度/,
    resolve: (asOf) => ({ from: startOfQuarter(asOf), to: endOfQuarter(asOf) }),
  },
  // 上季度
  {
    regex: /上季度/,
    resolve: (asOf) => {
      const prev = subMonths(asOf, 3);
      return { from: startOfQuarter(prev), to: endOfQuarter(prev) };
    },
  },
];

/**
 * 统计窗口是否整体越过数据水位（asOf = 数据最大日期）。
 * 命中即可在调模型之前拒答——「问了一个数据库里还不存在的时段」，
 * 0 token、毫秒级，优于「跑完 LLM+探针后归因」（docs/08 6G 后续优化）。
 * 只判「整体在后」：部分重叠（问近 30 天而数据止于月中）照常执行，
 * 由 C1 的水位检测出「末端不完整」标记——两种情况行为不同。
 * 注意窗口早于数据起点（to < minDate）需要另查 MIN(created_at)，本期不覆盖。
 */
export function isBeyondWatermark(
  resolution: { from: string; to: string } | null,
  asOf: string,
): boolean {
  // from/to 均为 YYYY-MM-DD，字典序即时间序
  return resolution !== null && resolution.from > asOf;
}

/**
 * 解析问题中的相对时间表达。解析不出时返回 null（调用方跳过，不报错）。
 * 只替换第一个命中 —— 多时间表达（「7 月和 8 月分别…」）不在本期范围。
 */
export function resolveTimeRange(question: string, asOf: string): TimeResolution | null {
  const asOfDate = parseAsOf(asOf);
  for (const rule of RULES) {
    const match = rule.regex.exec(question);
    if (!match) continue;
    const { from, to } = rule.resolve(asOfDate, match);
    const fromStr = ymd(from);
    const toStr = ymd(to);
    const sameDay = fromStr === toStr; // 单日区间：展示与改写都收敛为单个日期，避免「X 至 X」噪音
    return {
      expression: match[0],
      from: fromStr,
      to: toStr,
      display: sameDay ? fromStr : `${fromStr} ~ ${toStr}`,
      rewrittenQuestion: question.replace(match[0], sameDay ? fromStr : `${fromStr} 至 ${toStr}`),
    };
  }
  return null;
}
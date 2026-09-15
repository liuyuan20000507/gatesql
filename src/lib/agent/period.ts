/**
 * 不完整周期检测（5D，docs/08）：统计窗口越过数据水位线时，
 * 指出「窗口里第一个完全没有数据的月份」——趋势图末点据此画虚线，
 * 防止用户把「9 月还没有数据」读成「9 月销量为零」。
 *
 * 纯函数、确定性：输入只有已归一的窗口 + 时钟，不调模型。
 */

import { addMonths, format, isAfter, parseISO } from "date-fns";

export interface IncompletePeriod {
  /** 第一个完全没有数据的月份，如 "2026-09"（03-api-contract 的 lastPointLabel） */
  lastPointLabel: string;
  /** 数据水位线（asOf），如 "2026-08-31" */
  watermark: string;
}

export function detectIncompletePeriod(
  resolution: { from: string; to: string } | null,
  asOf: string,
): IncompletePeriod | null {
  if (!resolution) return null;
  // 窗口止于水位线之前：完整，无告警
  if (!isAfter(parseISO(resolution.to), parseISO(asOf))) return null;

  // 水位线所在月的下一个月 = 第一个「整月无数据」的月份。
  // 若窗口延伸不到那个月（如截止 8/15、窗口到 8/31），末月只是部分覆盖，
  // 不谎报为「完全没有数据」——但数据截止横幅仍由回执/水位线信息呈现。
  const firstEmptyMonth = format(addMonths(parseISO(asOf), 1), "yyyy-MM");
  const windowEndMonth = format(parseISO(resolution.to), "yyyy-MM");
  if (firstEmptyMonth > windowEndMonth) return null;

  return { lastPointLabel: firstEmptyMonth, watermark: asOf };
}

import type { IncompletePeriodInput } from "@/lib/chart-option";

/**
 * 不完整周期横幅（5D）：与图表无关 —— 只要 verification 事件带了
 * incompletePeriod，无论模型画不画图都必须展示（实测踩过：模型把
 * 无数据的月份补成 0 且不绘图，只有图表内横幅时警示完全丢失）。
 */
export function IncompleteBanner({ period }: { period?: IncompletePeriodInput }) {
  if (!period) return null;
  return (
    <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
      <span className="font-medium">不完整周期：</span>
      数据截止 {period.watermark}，{period.lastPointLabel} 起窗口内没有数据 —— 结果里该时间段的
      0 / 空行是「尚无数据」，不是「业务为零」。
    </p>
  );
}

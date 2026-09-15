/**
 * ChartSpec → ECharts option 的确定性编译器。
 *
 * spec 引用了表格里不存在的列，或 kind 为 none 时返回 null ——
 * 界面降级为只显示表格，绝不渲染半错误的图。
 */

import type { EChartsCoreOption } from "echarts/core";

import type { ChartSpec } from "@/lib/events";
import type { ResultTable } from "@/lib/reduce-events";

export interface IncompletePeriodInput {
  lastPointLabel: string;
  watermark: string;
}

export function compileChartOption(
  spec: ChartSpec,
  table: ResultTable,
  incompletePeriod?: IncompletePeriodInput,
): EChartsCoreOption | null {
  if (spec.kind === "none") return null;
  if (!table.columns.includes(spec.x)) return null;
  if (!spec.y.every((name) => table.columns.includes(name))) return null;

  const xIndex = table.columns.indexOf(spec.x);
  const yIndex = table.columns.indexOf(spec.y[0]);
  let categories = table.rows.map((row) => String(row[xIndex] ?? ""));
  let values = table.rows.map((row) => row[yIndex]);

  // 5D：趋势窗口越过数据水位线 → 补一个「完全没有数据的月份」空点，
  // 末段以虚线画到占位处并挂标注，防止"无数据"被读成"零销量"
  let markLine: unknown = undefined;
  if (
    incompletePeriod &&
    (spec.kind === "line" || spec.kind === "bar") &&
    !categories.includes(incompletePeriod.lastPointLabel)
  ) {
    categories = [...categories, incompletePeriod.lastPointLabel];
    values = [...values, null];
    markLine = {
      symbol: "none",
      silent: true,
      lineStyle: { type: "dashed", color: "#d97706" },
      label: { formatter: `数据截止 ${incompletePeriod.watermark}，此点起不完整` },
      data: [{ xAxis: incompletePeriod.lastPointLabel }],
    };
  }

  const tooltip = { trigger: "axis" as const };

  switch (spec.kind) {
    case "bar":
    case "line":
      return {
        tooltip,
        xAxis: { type: "category", data: categories },
        yAxis: { type: "value" },
        series: [
          {
            type: spec.kind,
            data: values,
            name: spec.title,
            connectNulls: false,
            ...(markLine ? { markLine } : {}),
          },
        ],
      };
    case "pie":
      return {
        tooltip: { trigger: "item" as const },
        series: [
          {
            type: "pie",
            data: table.rows.map((row) => ({ name: String(row[xIndex] ?? ""), value: row[yIndex] })),
          },
        ],
      };
  }
}

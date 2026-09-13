/**
 * ChartSpec → ECharts option 的确定性编译器。
 *
 * spec 引用了表格里不存在的列，或 kind 为 none 时返回 null ——
 * 界面降级为只显示表格，绝不渲染半错误的图。
 */

import type { EChartsCoreOption } from "echarts/core";

import type { ChartSpec } from "@/lib/events";
import type { ResultTable } from "@/lib/reduce-events";

export function compileChartOption(spec: ChartSpec, table: ResultTable): EChartsCoreOption | null {
  if (spec.kind === "none") return null;
  if (!table.columns.includes(spec.x)) return null;
  if (!spec.y.every((name) => table.columns.includes(name))) return null;

  const xIndex = table.columns.indexOf(spec.x);
  const yIndex = table.columns.indexOf(spec.y[0]);
  const categories = table.rows.map((row) => String(row[xIndex] ?? ""));
  const values = table.rows.map((row) => row[yIndex]);

  const tooltip = { trigger: "axis" as const };

  switch (spec.kind) {
    case "bar":
    case "line":
      return {
        tooltip,
        xAxis: { type: "category", data: categories },
        yAxis: { type: "value" },
        series: [{ type: spec.kind, data: values, name: spec.title }],
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

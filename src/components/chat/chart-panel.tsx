"use client";

import { useEffect, useRef } from "react";

import { compileChartOption, type IncompletePeriodInput } from "@/lib/chart-option";
import type { ChartSpec } from "@/lib/events";
import type { ResultTable } from "@/lib/reduce-events";

/** 只依赖 echarts 用到的最小能力面，避免 any */
interface MinimalChart {
  setOption(option: unknown): void;
  dispose(): void;
}

/**
 * ECharts 渲染。库文件全部在 effect 内动态 import —— echarts 体积大，
 * 且不能被 SSR 打包（它依赖 window）。
 */
export function ChartPanel({
  spec,
  table,
  incompletePeriod,
}: {
  spec: ChartSpec;
  table: ResultTable;
  incompletePeriod?: IncompletePeriodInput;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let chart: MinimalChart | null = null;

    (async () => {
      const option = compileChartOption(spec, table, incompletePeriod);
      if (!option || !containerRef.current) return; // spec 不合法 → 降级为纯表格

      const echarts = await import("echarts/core");
      const { BarChart, LineChart, PieChart } = await import("echarts/charts");
      const { GridComponent, TooltipComponent, LegendComponent } = await import("echarts/components");
      const { CanvasRenderer } = await import("echarts/renderers");
      echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

      if (disposed || !containerRef.current) return;
      chart = echarts.init(containerRef.current) as unknown as MinimalChart;
      chart.setOption(option);
    })();

    return () => {
      disposed = true;
      chart?.dispose();
    };
  }, [spec, table, incompletePeriod]);

  return (
    <div>
      <div ref={containerRef} className="h-64 w-full" />
      <p className="text-center text-xs text-neutral-500">{spec.title}</p>
      {incompletePeriod && (
        <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-center text-xs text-amber-800">
          {incompletePeriod.lastPointLabel} 起为不完整周期（数据截止 {incompletePeriod.watermark}），虚线处无数据 ≠ 销量为零
        </p>
      )}
    </div>
  );
}

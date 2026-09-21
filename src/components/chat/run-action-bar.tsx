"use client";

import Link from "next/link";

import { SaveReportButton } from "@/components/chat/save-report-button";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

/**
 * 答案区顶部操作栏：历史回放 + 存为报表 + 导出 CSV。
 * 此前两个入口藏在页底灰色统计行的下划线小字里，可发现性差（实测反馈），
 * 提升为状态条正下方的显式按钮。
 */
export function RunActionBar({
  runId,
  enabled,
  canExport,
}: {
  runId: string;
  enabled: boolean;
  canExport: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/runs/${runId}`} className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
        历史回放
      </Link>
      <SaveReportButton runId={runId} enabled={enabled} />
      {canExport && (
        <a
          href={`/api/export/${runId}`}
          download
          className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          title="下载结果表格（UTF-8 BOM，Excel 直接打开中文不乱码）"
        >
          导出 CSV
        </a>
      )}
    </div>
  );
}

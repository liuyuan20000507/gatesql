"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { saveReportFromRun } from "@/app/reports/actions";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";

/**
 * 5G：把「已核验」的答案一键固化为报表（只存 SQL，不存结果）。
 * 未核验时不消失而是禁用 + 提示 —— 功能可发现性优先于隐藏（实测反馈）。
 */
export function SaveReportButton({ runId, enabled }: { runId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={pending || !enabled}
        title={enabled ? "把这条已核验的 SQL 固化为报表" : "仅「已核验」的答案可存为报表"}
        onClick={() =>
          startTransition(async () => {
            setResult(await saveReportFromRun(runId));
          })
        }
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), !enabled && "opacity-50")}
      >
        {pending ? "保存中…" : "存为报表"}
      </button>
      {result?.ok ? (
        <span className="text-green-700">
          已固化 <Link href={`/reports/${result.message}`} className="underline">{result.message}</Link>
        </span>
      ) : (
        result && <span className="text-red-700">{result.message}</span>
      )}
    </div>
  );
}

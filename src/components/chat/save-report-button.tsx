"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { saveReportFromRun } from "@/app/reports/actions";

/** 5G：把「已核验」的答案一键固化为报表（只存 SQL，不存结果） */
export function SaveReportButton({ runId, enabled }: { runId: string; enabled: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  if (!enabled) return null;

  return (
    <div className="flex items-center gap-2 text-xs">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setResult(await saveReportFromRun(runId));
          })
        }
        className="rounded border border-neutral-300 px-2 py-1 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
      >
        {pending ? "保存中…" : "存为报表"}
      </button>
      {result?.ok ? (
        <span className="text-green-700">
          已固化 <Link href={`/reports/${result.message}`} className="underline">{result.message}</Link> ·{" "}
          <Link href="/reports" className="underline">报表列表</Link>
        </span>
      ) : (
        result && <span className="text-red-700">{result.message}</span>
      )}
    </div>
  );
}

"use client";

import { useActionState } from "react";

import { saveCorrectionFromEdit, type ActionResult } from "@/app/reports/actions";

/**
 * 5G：纠正样本回流 —— 人工把 SQL 改对 → 安全校验 + 只读重跑确认 →
 * 存进 corrections（verified）。这些样本是 few-shot 检索的地基
 * （FEW_SHOT=on 时按表/词重叠召回）。
 */
export function CorrectionForm({ runId, initialSql }: { runId: string; initialSql: string | null }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    async (_prev, formData) => saveCorrectionFromEdit(runId, String(formData.get("sql") ?? "")),
    null,
  );

  if (initialSql === null) return null;

  return (
    <details className="rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none p-3 text-sm font-medium text-neutral-700">
        SQL 不对？人工改对并回流为纠正样本
      </summary>
      <form action={formAction} className="space-y-2 border-t border-neutral-100 p-3">
        <textarea
          name="sql"
          rows={4}
          defaultValue={initialSql}
          className="w-full rounded border border-neutral-300 p-2 font-mono text-xs"
          spellCheck={false}
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-neutral-300 px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {pending ? "校验并重跑中…" : "校验 · 重跑 · 存为纠正样本"}
        </button>
        {state && (
          <p className={`text-xs ${state.ok ? "text-green-700" : "text-red-700"}`}>{state.message}</p>
        )}
        <p className="text-[11px] text-neutral-400">
          入库前会过安全检查并只读重跑一次；样本 verified 后供 few-shot 检索使用。
        </p>
      </form>
    </details>
  );
}

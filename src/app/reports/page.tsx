import Link from "next/link";

import { listReports, openAppDb } from "@/lib/db/app";

/** 报表列表（5G）：固化的 SQL 目录。点「重跑」直接执行存好的 SQL，不调模型。 */
// 渲染期读 app.db：必须按需渲染 —— 否则 next build 的预渲染阶段会去开一个不存在的数据库
// （Docker 构建阶段 data/ 不在上下文里，正是这个坑暴露的）
export const dynamic = "force-dynamic";

export default function ReportsPage() {
  const db = openAppDb();
  let reports;
  try {
    reports = listReports(db);
  } finally {
    db.close();
  }

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← 返回
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">固化报表</h1>
      </div>

      {reports.length === 0 ? (
        <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
          还没有报表。在问答页把「已核验」的答案点「存为报表」，它的 SQL 就会固化在这里 ——
          以后点开直接执行，不调模型、毫秒级、结果永远一致。
        </p>
      ) : (
        <ul className="space-y-3">
          {reports.map((r) => (
            <li key={r.id} className="rounded-lg border border-neutral-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <Link href={`/reports/${r.id}`} className="font-medium hover:underline">
                  {r.name}
                </Link>
                <span className="text-xs text-neutral-400">{r.createdAt.slice(0, 16).replace("T", " ")}</span>
              </div>
              <p className="mt-1 truncate font-mono text-xs text-neutral-500">{r.sql}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

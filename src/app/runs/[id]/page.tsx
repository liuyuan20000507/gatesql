import Link from "next/link";

import { ChartPanel } from "@/components/chat/chart-panel";
import { ReceiptCard } from "@/components/chat/receipt-card";
import { ResultTable } from "@/components/chat/result-table";
import { SqlAttemptsPanel } from "@/components/chat/sql-attempts-panel";
import { StatusBar } from "@/components/chat/status-bar";
import { Badge } from "@/components/ui/badge";
import { getEventsForRun, openAppDb } from "@/lib/db/app";
import { reduceEvents } from "@/lib/reduce-events";

/**
 * 历史回放页。
 *
 * 服务端读取该次 run 的落库事件，用与实时页面同一个 reduceEvents 折叠、
 * 渲染同一批组件 —— 两处不可能不一致，这就是 1B 那步设计的兑现时刻。
 * 事件来自 app.db 的 events 表（2H 起由 route 落库），重启后依然存在。
 */

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }: PageProps<"/runs/[id]">) {
  const { id } = await params;

  const db = openAppDb();
  let events;
  try {
    events = getEventsForRun(db, id);
  } finally {
    db.close();
  }

  if (events.length === 0) {
    return (
      <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← 返回
        </Link>
        <div className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          找不到 id 为 <code className="rounded bg-amber-100 px-1">{id}</code> 的问答记录。
        </div>
      </main>
    );
  }

  const state = reduceEvents(events);

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <Link href="/" className="text-sm text-neutral-500 hover:underline">
          ← 返回
        </Link>
        <span className="font-mono text-xs text-neutral-400">{id}</span>
      </div>

      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">历史回放 · {id}</h1>
        <p className="text-sm text-neutral-500">
          本页由服务端用与实时页面相同的折叠函数渲染，内容与实时过程逐字一致。
        </p>
      </header>

      <div className="space-y-4">
        <StatusBar phase={state.phase} timeDisplay={state.timeDisplay} verdict={state.verdict} />

        {state.attempts.length > 0 && <SqlAttemptsPanel attempts={state.attempts} />}

        {state.verdict === "refused" && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
            <div className="mb-2"><Badge variant="destructive">已拒答</Badge></div>
            <ul className="list-disc pl-5 text-xs text-red-800">
              {state.verdictReasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {state.result && <ResultTable table={state.result} />}

        {state.chart && state.result && <ChartPanel spec={state.chart} table={state.result} />}

        {state.summaryText && <p className="text-sm leading-relaxed">{state.summaryText}</p>}

        {state.receipt && <ReceiptCard receipt={state.receipt} />}

        {state.stats && (
          <p className="text-xs text-neutral-400">
            {state.stats.attempts} 次尝试 · {state.stats.llmCalls} 次模型调用 ·{" "}
            {state.stats.tokensInput + state.stats.tokensOutput} tokens ·{" "}
            {state.stats.elapsedMs} ms
          </p>
        )}
      </div>
    </main>
  );
}

import Link from "next/link";

import { ChartPanel } from "@/components/chat/chart-panel";
import { EmptyReasonBanner, IncompleteBanner } from "@/components/chat/verification-banners";
import { ReceiptCard } from "@/components/chat/receipt-card";
import { ResultTable } from "@/components/chat/result-table";
import { SqlAttemptsPanel } from "@/components/chat/sql-attempts-panel";
import { StatusBar } from "@/components/chat/status-bar";
import { TracePanel } from "@/components/chat/trace-panel";
import { VerdictPanel } from "@/components/chat/verdict-panel";
import { getEventsForRun, getStepsForRun, openAppDb } from "@/lib/db/app";
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
  let steps;
  try {
    events = getEventsForRun(db, id);
    steps = getStepsForRun(db, id);
  } finally {
    db.close();
  }

  // 评测跑出的 run 只有 steps 没有 events（事件在聊天路由落库）——
  // 两者都为空才算「找不到记录」，否则追踪面板对用户仍然可用
  if (events.length === 0 && steps.length === 0) {
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
        {events.length === 0 && (
          <p className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-500">
            这条记录来自评测脚本（不经聊天路由，无 SSE 事件），只展示执行追踪。
          </p>
        )}
        <StatusBar phase={state.phase} timeDisplay={state.timeDisplay} verdict={state.verdict} />

        {state.attempts.length > 0 && <SqlAttemptsPanel attempts={state.attempts} />}

        {state.verdict === "refused" ||
        (state.verdict === "unverified" && state.verdictReasons.length > 0) ? (
          <VerdictPanel
            verdict={state.verdict}
            reasons={state.verdictReasons}
            clarifications={state.clarifications}
          />
        ) : null}

        {state.result && <EmptyReasonBanner reason={state.verification?.emptyReason} />}
        {state.result && <IncompleteBanner period={state.verification?.incompletePeriod} />}

        {state.result && <ResultTable table={state.result} />}

        {state.chart && state.result && (
          <ChartPanel
            spec={state.chart}
            table={state.result}
            incompletePeriod={state.verification?.incompletePeriod ?? undefined}
          />
        )}

        {state.summaryText && <p className="text-sm leading-relaxed">{state.summaryText}</p>}

        {state.receipt && <ReceiptCard receipt={state.receipt} />}

        {state.stats && (
          <p className="text-xs text-neutral-400">
            {state.stats.attempts} 次尝试 · {state.stats.llmCalls} 次模型调用 ·{" "}
            {state.stats.tokensInput + state.stats.tokensOutput} tokens ·{" "}
            {state.stats.elapsedMs} ms
          </p>
        )}

        <TracePanel steps={steps} />
      </div>
    </main>
  );
}

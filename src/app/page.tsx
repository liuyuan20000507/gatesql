"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ChartPanel } from "@/components/chat/chart-panel";
import { IncompleteBanner } from "@/components/chat/incomplete-banner";
import { ReceiptCard } from "@/components/chat/receipt-card";
import { ResultTable } from "@/components/chat/result-table";
import { SqlAttemptsPanel } from "@/components/chat/sql-attempts-panel";
import { StatusBar } from "@/components/chat/status-bar";
import { VerdictPanel } from "@/components/chat/verdict-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CaliberEvent } from "@/lib/events";
import { emptyRunState, reduceEvent, type RunState } from "@/lib/reduce-events";
import { postChatStream } from "@/lib/sse-client";

export default function Home() {
  // reset 与事件分两类 action：新提问必须清空上一次的状态，
  // 否则 attempts/summaryText 会跨 run 累加（实测踩过：结论文字翻倍）
  const [state, dispatch] = useReducer(
    (s: RunState, action: { kind: "reset" } | { kind: "event"; event: CaliberEvent }) =>
      action.kind === "reset" ? emptyRunState() : reduceEvent(s, action.event),
    undefined,
    emptyRunState,
  );
  const dispatchEvent = useCallback((event: CaliberEvent) => dispatch({ kind: "event", event }), []);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 组件卸载时中止在途请求 —— StrictMode 下尤其必要
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async () => {
    const question = input.trim();
    if (!question || streaming) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setStreaming(true);
    dispatch({ kind: "reset" });

    try {
      await postChatStream("/api/chat", { question, conversationId: null }, dispatchEvent, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        dispatchEvent({ type: "error", code: "LLM_ERROR", message: String(err) });
      }
    } finally {
      setStreaming(false);
    }
  }, [input, streaming]);

  const hasRun = state.runId !== null;
  const inFlight = streaming && !state.finished;

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Caliber</h1>
        <p className="text-sm text-neutral-500">会对错口径说不的取数 agent —— 已核验 / 未核验 / 拒答，三态交付</p>
      </header>

      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="用中文问一个问题，例如：2026 年上半年各商品分类的销售额排名"
          disabled={inFlight}
        />
        <Button type="submit" disabled={!input.trim() || inFlight}>
          {inFlight ? "查询中…" : "发送"}
        </Button>
      </form>

      {hasRun && (
        <div className="space-y-4">
          <StatusBar phase={state.phase} timeDisplay={state.timeDisplay} verdict={state.verdict} />

          {state.attempts.length > 0 && <SqlAttemptsPanel attempts={state.attempts} />}

          {state.error && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <span className="font-medium">出错（{state.error.code}）：</span>
              {state.error.message}
            </div>
          )}

          <VerdictPanel
            verdict={state.verdict}
            reasons={state.verdictReasons}
            clarifications={state.clarifications}
            onClarify={(q) => {
              setInput(q);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          />

          {state.result && <IncompleteBanner period={state.verification?.incompletePeriod} />}

          {state.result && <ResultTable table={state.result} />}

          {state.chart && state.result && (
            <ChartPanel
              spec={state.chart}
              table={state.result}
              incompletePeriod={state.verification?.incompletePeriod ?? undefined}
            />
          )}

          {state.summaryText && (
            <p className="text-sm leading-relaxed">{state.summaryText}</p>
          )}

          {state.receipt && <ReceiptCard receipt={state.receipt} />}

          {state.stats && (
            <p className="text-xs text-neutral-400">
              {state.stats.attempts} 次尝试 · {state.stats.llmCalls} 次模型调用 ·{" "}
              {state.stats.tokensInput + state.stats.tokensOutput} tokens ·{" "}
              {state.stats.elapsedMs} ms ·{" "}
              <a href={`/runs/${state.runId}`} className="underline hover:text-neutral-600">
                查看历史回放
              </a>
            </p>
          )}
        </div>
      )}
    </main>
  );
}

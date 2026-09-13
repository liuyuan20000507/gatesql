"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ChartPanel } from "@/components/chat/chart-panel";
import { ReceiptCard } from "@/components/chat/receipt-card";
import { ResultTable } from "@/components/chat/result-table";
import { SqlAttemptsPanel } from "@/components/chat/sql-attempts-panel";
import { StatusBar } from "@/components/chat/status-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CaliberEvent } from "@/lib/events";
import { emptyRunState, reduceEvent } from "@/lib/reduce-events";
import { postChatStream } from "@/lib/sse-client";

export default function Home() {
  const [state, dispatchEvent] = useReducer(reduceEvent, undefined, emptyRunState);
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
        <p className="text-sm text-neutral-500">会对错口径说「不」的取数 agent（第 1 周：界面为真，数据为剧本）</p>
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

          {state.verdict === "refused" && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
              <div className="mb-2"><Badge variant="destructive">已拒答</Badge></div>
              <ul className="mb-2 list-disc pl-5 text-xs text-red-800">
                {state.verdictReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {state.clarifications.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => setInput(c.label)}
                  className="mr-2 rounded border border-red-300 bg-white px-2 py-1 text-xs hover:bg-red-50"
                  title={c.description}
                >
                  {c.label}
                </button>
              ))}
            </div>
          )}

          {state.result && <ResultTable table={state.result} />}

          {state.chart && state.result && (
            <ChartPanel spec={state.chart} table={state.result} />
          )}

          {state.summaryText && (
            <p className="text-sm leading-relaxed">{state.summaryText}</p>
          )}

          {state.receipt && <ReceiptCard receipt={state.receipt} />}

          {state.stats && (
            <p className="text-xs text-neutral-400">
              {state.stats.attempts} 次尝试 · {state.stats.llmCalls} 次模型调用 ·{" "}
              {state.stats.tokensInput + state.stats.tokensOutput} tokens ·{" "}
              {state.stats.elapsedMs} ms
            </p>
          )}
        </div>
      )}
    </main>
  );
}

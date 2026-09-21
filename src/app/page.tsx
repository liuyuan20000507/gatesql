"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { ChartPanel } from "@/components/chat/chart-panel";
import { EmptyReasonBanner, IncompleteBanner } from "@/components/chat/verification-banners";
import { ReceiptCard } from "@/components/chat/receipt-card";
import { RunActionBar } from "@/components/chat/run-action-bar";
import { ResultTable } from "@/components/chat/result-table";
import { SqlAttemptsPanel } from "@/components/chat/sql-attempts-panel";
import { StatusBar } from "@/components/chat/status-bar";
import { VerdictPanel } from "@/components/chat/verdict-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { GateSqlEvent } from "@/lib/events";
import { DEMO_QUESTIONS } from "@/lib/demo-questions";
import { emptyRunState, reduceEvent, type RunState } from "@/lib/reduce-events";
import { postChatStream } from "@/lib/sse-client";

/** 当前 run 事件快照的 sessionStorage 键（标签页内保留，重开浏览器自然清空） */
const RESTORE_KEY = "gatesql:last-run-events";

export default function Home() {
  // reset 与事件分两类 action：新提问必须清空上一次的状态，
  // 否则 attempts/summaryText 会跨 run 累加（实测踩过：结论文字翻倍）
  const [state, dispatch] = useReducer(
    (s: RunState, action: { kind: "reset" } | { kind: "event"; event: GateSqlEvent }) =>
      action.kind === "reset" ? emptyRunState() : reduceEvent(s, action.event),
    undefined,
    emptyRunState,
  );
  // 会话级现场保存：本 tab 内点进回放/切页再返回，问答现场不丢。
  // 事件流是状态的唯一事实源（reduceEvents 纯函数），存事件 = 存全部现场。
  const eventsRef = useRef<GateSqlEvent[]>([]);
  const restoredRef = useRef(false);
  const dispatchEvent = useCallback(
    (event: GateSqlEvent) => {
      eventsRef.current.push(event);
      dispatch({ kind: "event", event });
    },
    [],
  );
  const [input, setInput] = useState("");
  /** 当前 run 的问题原文 —— 澄清选项点击时拼回话术用 */
  const [askedQuestion, setAskedQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 组件卸载时中止在途请求 —— StrictMode 下尤其必要
  useEffect(() => () => abortRef.current?.abort(), []);

  // 挂载：恢复上一次 run 的事件并重放进 reducer（ref 哨兵防 StrictMode 双执行重复恢复）
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const raw = sessionStorage.getItem(RESTORE_KEY);
    if (!raw) return;
    try {
      for (const event of JSON.parse(raw) as GateSqlEvent[]) dispatch({ kind: "event", event });
    } catch {
      sessionStorage.removeItem(RESTORE_KEY);
    }
  }, [dispatch]);

  // 卸载：把当前 run 的事件快照写入 sessionStorage（ref 为空说明刚恢复过，保留旧快照）
  useEffect(
    () => () => {
      if (eventsRef.current.length > 0) {
        sessionStorage.setItem(RESTORE_KEY, JSON.stringify(eventsRef.current));
      }
    },
    [],
  );

  const sendQuestion = useCallback(
    async (question: string) => {
      const q = question.trim();
      if (!q || streaming) return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setStreaming(true);
      setAskedQuestion(q);
      dispatch({ kind: "reset" });
      eventsRef.current = []; // 新提问：事件快照从零开始积累，结束后覆盖旧现场

      try {
        await postChatStream("/api/chat", { question: q, conversationId: null }, dispatchEvent, ac.signal);
      } catch (err) {
        if (!ac.signal.aborted) {
          dispatchEvent({ type: "error", code: "LLM_ERROR", message: String(err) });
        }
      } finally {
        setStreaming(false);
      }
    },
    [streaming, dispatchEvent],
  );

  const send = useCallback(() => void sendQuestion(input), [sendQuestion, input]);

  const hasRun = state.runId !== null;
  const inFlight = streaming && !state.finished;

  return (
    <main className="mx-auto min-h-dvh max-w-3xl px-4 py-8">
      <header className="mb-8">
        <h1 className="font-serif-sc text-3xl font-bold tracking-tight text-foreground">
          用中文问数，每个数字都要过闸。
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          每个答案都带三态结论与口径回执 —— 核验、存疑、拒答，绝不冒充。
        </p>
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

      <div className="mb-6">
        <p className="mb-2 text-xs text-muted-foreground">试试这些（每个都实测可跑，无 key 时走本地回放）：</p>
        <div className="flex flex-wrap gap-1.5">
          {DEMO_QUESTIONS.map((d) => (
            <button
              key={d.question}
              type="button"
              title={d.highlight}
              disabled={inFlight}
              onClick={() => setInput(d.question)}
              className="rounded border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:opacity-50"
            >
              {d.question}
            </button>
          ))}
        </div>
      </div>

      {hasRun && (
        <div className="space-y-4">
          <StatusBar phase={state.phase} timeDisplay={state.timeDisplay} verdict={state.verdict} />

          {state.finished && state.runId && (
            <RunActionBar
              runId={state.runId}
              enabled={state.verdict === "verified"}
              canExport={state.result !== null}
            />
          )}

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
            onClarify={(c) => {
              // 词典选项带 clarifyPhrase → 拼回原问题自动重问（多轮澄清）；
              // 「可查表」类提示无话术 → 退回旧行为：填入输入框由用户编辑
              if (c.clarifyPhrase && askedQuestion) {
                void sendQuestion(`${askedQuestion}${c.clarifyPhrase}`);
              } else {
                setInput(`${c.label}：${c.description}`);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          />

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

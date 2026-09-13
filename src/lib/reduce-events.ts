/**
 * 事件折叠：把 CaliberEvent 流折叠成界面状态 RunState。
 *
 * 这是纯函数 —— 不 import React、不做 IO、不改入参。同一份代码服务三个场景：
 *   - 实时对话页：useReducer 消费增量事件（每来一条调一次 reduceEvent）
 *   - /runs/[id] 历史页：服务端对落库的历史事件一次折叠（reduceEvents）
 *   - 单测：直接喂假事件数组
 *
 * 从架构上消灭「刷新后看到的和实时看到的不一致」这类 bug ——
 * 因为两个场景根本不可能不一致：它们用的是同一个函数。
 */

import type { CaliberEvent, ChartSpec, LintViolation, RuleId, Verdict } from "./events";

export type RunCell = string | number | boolean | null;

/** 一次 SQL 尝试 = 生成 + 它的口径 lint 结果（可能没有 lint 记录，如被 guard 拦下） */
export interface SqlAttempt {
  attempt: number;
  sql: string;
  citedRules: RuleId[];
  lint: LintViolation[];
}

export interface ResultTable {
  columns: string[];
  rows: RunCell[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs: number;
}

export interface VerificationCheck {
  kind: "empty_result" | "suspicious_shape" | "data_watermark" | "magnitude";
  passed: boolean;
  detail: string;
}

export interface Verification {
  checks: VerificationCheck[];
  emptyReason?: {
    suspectCondition: string;
    countIfRelaxed: number;
  };
  incompletePeriod?: {
    lastPointLabel: string;
    watermark: string;
  };
}

export interface RunError {
  code: string;
  message: string;
  detail?: string;
}

/** 界面所处阶段的粗粒度描述，驱动状态条的文案 */
export type RunPhase =
  | "understanding"
  | "sql"
  | "executing"
  | "verifying"
  | "summarizing"
  | "done"
  | "failed";

export interface RunStats {
  elapsedMs: number;
  attempts: number;
  llmCalls: number;
  tokensInput: number;
  tokensOutput: number;
  costCny: number;
}

export interface RunState {
  runId: string | null;
  asOfDate: string | null;
  phase: RunPhase;

  /** 全部 SQL 尝试，并列保留 —— 招牌演示需要左右对比第 1 次和第 2 次 */
  attempts: SqlAttempt[];
  result: ResultTable | null;

  verification: Verification | null;
  receipt: {
    scope: string;
    filters: string[];
    method: string;
    dataUntil: string;
    coverage: string;
    fullyTranslated: boolean;
  } | null;

  verdict: Verdict | null;
  verdictReasons: string[];
  clarifications: Array<{ label: string; description: string }>;

  chart: ChartSpec | null;
  /** 结论文字，text_delta 逐段拼接 */
  summaryText: string;

  error: RunError | null;
  /** done 事件已到。前端只看它解除 loading —— done 任何分支下必发 */
  finished: boolean;
  stats: RunStats | null;
}

export function emptyRunState(): RunState {
  return {
    runId: null,
    asOfDate: null,
    phase: "understanding",
    attempts: [],
    result: null,
    verification: null,
    receipt: null,
    verdict: null,
    verdictReasons: [],
    clarifications: [],
    chart: null,
    summaryText: "",
    error: null,
    finished: false,
    stats: null,
  };
}

/**
 * 单步折叠。必须返回新对象而不是原地修改 —— React useReducer 依赖
 * 引用变化来判断要不要重渲染。
 */
export function reduceEvent(state: RunState, event: CaliberEvent): RunState {
  switch (event.type) {
    case "run_started":
      return { ...state, runId: event.runId, asOfDate: event.asOfDate, phase: "understanding" };

    case "time_resolved":
      return { ...state, asOfDate: event.to };

    case "context_built":
      // 表名列表只在演示时有意义，不进状态条；保留 phase 推进即可
      return state;

    case "sql_generated":
      return {
        ...state,
        phase: "sql",
        attempts: [
          ...state.attempts,
          { attempt: event.attempt, sql: event.sql, citedRules: event.citedRules, lint: [] },
        ],
      };

    case "lint_result":
      return {
        ...state,
        attempts: state.attempts.map((a) =>
          a.attempt === event.attempt ? { ...a, lint: event.violations } : a,
        ),
      };

    case "rows":
      return {
        ...state,
        phase: "executing",
        result: {
          columns: event.columns,
          rows: event.rows,
          rowCount: event.rowCount,
          truncated: event.truncated,
          elapsedMs: event.elapsedMs,
        },
      };

    case "verification":
      return { ...state, phase: "verifying", verification: { ...event } };

    case "receipt":
      return {
        ...state,
        receipt: {
          scope: event.scope,
          filters: event.filters,
          method: event.method,
          dataUntil: event.dataUntil,
          coverage: event.coverage,
          fullyTranslated: event.fullyTranslated,
        },
      };

    case "state":
      return {
        ...state,
        phase: "summarizing",
        verdict: event.verdict,
        verdictReasons: event.reasons,
        clarifications: event.clarifications ?? [],
      };

    case "chart":
      return { ...state, chart: event.spec };

    case "text_delta":
      return { ...state, summaryText: state.summaryText + event.delta };

    case "error":
      return {
        ...state,
        phase: "failed",
        error: { code: event.code, message: event.message, detail: event.detail },
      };

    case "done":
      return {
        ...state,
        finished: true,
        phase: state.error ? "failed" : "done",
        stats: {
          elapsedMs: event.elapsedMs,
          attempts: event.attempts,
          llmCalls: event.llmCalls,
          tokensInput: event.tokens.input,
          tokensOutput: event.tokens.output,
          costCny: event.costCny,
        },
      };

    default: {
      // 少处理任何一种事件类型，这里就是编译错误而不是运行时事故
      const _exhaustive: never = event;
      throw new Error(`未处理的事件类型: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

/** 整段折叠。历史页和单测用 */
export function reduceEvents(events: CaliberEvent[]): RunState {
  return events.reduce(reduceEvent, emptyRunState());
}

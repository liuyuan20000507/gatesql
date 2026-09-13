/**
 * Caliber 的唯一契约：SSE 事件协议。
 *
 * 这个文件被三方 import 同一份：
 *   - Route Handler（生产者）：app/api/chat/route.ts
 *   - 前端（消费者）：useReducer 事件流
 *   - 评测脚本（回放消费者）：scripts/eval.ts
 *
 * 契约漂移必须升级为编译失败：前端 switch 上加 satisfies never 穷尽检查，
 * 少处理一种事件类型就 build 不过。详见 docs/03-api-contract.md。
 *
 * 本文件只允许新增事件类型或在事件内加可选字段；
 * 改字段名、改语义、删事件 = 破坏契约，必须先改文档并同步三方。
 */

import { z } from "zod";

/* ------------------------------------------------------------------ */
/* 请求体                                                              */
/* ------------------------------------------------------------------ */

export const ChatRequestSchema = z.object({
  /** 用户的自然语言问题，1-500 字 */
  question: z.string().min(1).max(500),
  /** 第一次提问传 null，后端生成并随 done 事件返回 */
  conversationId: z.string().nullable(),
  /** 覆盖默认时钟（默认 = max(orders.created_at)），评测可复现用 */
  asOfDate: z.string().date().optional(),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/* ------------------------------------------------------------------ */
/* 公共子结构                                                          */
/* ------------------------------------------------------------------ */

/**
 * 图表规格。模型只允许输出这个极小的结构，前端做确定性编译成 ECharts option；
 * 绝不让模型直出 ECharts option —— 字段空间无限大、校验不可能完备，
 * 一个笔误就是运行时白屏。
 */
export const ChartSpecSchema = z.object({
  kind: z.enum(["bar", "line", "pie", "none"]),
  x: z.string(),
  y: z.array(z.string()),
  series: z.string().optional(),
  title: z.string(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

/** 口径规则 id，对应 src/lib/sql/rules.ts 里的 8 条规则（R1~R8） */
export const RuleIdSchema = z.enum(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8"]);

export const LintViolationSchema = z.object({
  ruleId: RuleIdSchema,
  /** block = 不执行、回喂重生成；warn = 继续执行但答案降级为「未核验」 */
  level: z.enum(["block", "warn"]),
  /** 缺失的具体谓词，如 "orders.status = '已完成'" —— 回喂给模型的就是它 */
  missingPredicate: z.string(),
  /** 中文修复建议 */
  suggestion: z.string(),
});

/** 结果体检的四类确定性检查 */
export const VerificationCheckKindSchema = z.enum([
  "empty_result",
  "suspicious_shape",
  "data_watermark",
  "magnitude",
]);

export const ErrorCodeSchema = z.enum([
  /** guard 拦下危险语句（不重试，直接终止） */
  "UNSAFE_SQL",
  /** EQP 预检判定缺失连接条件 */
  "COST_REJECTED",
  /** 重试预算耗尽仍失败 */
  "SQL_FAILED",
  /** 问题涉及的实体在 schema 里不存在 → 走拒答 */
  "NO_RELEVANT_TABLE",
  /** 执行超过 5 秒 */
  "TIMEOUT",
  /** 超出单 run 或日预算 → 优雅降级 */
  "BUDGET_EXCEEDED",
  /** 结构化输出解析失败且自修无效 → 走拒答 */
  "SCHEMA_PARSE_FAILED",
  /** 模型接口异常 */
  "LLM_ERROR",
]);

/** 三态判定。verdict 的依据是四类确定性信号，与模型自我声明无关 */
export const VerdictSchema = z.enum(["verified", "unverified", "refused"]);

/* ------------------------------------------------------------------ */
/* 事件定义                                                            */
/* ------------------------------------------------------------------ */

export const CaliberEventSchema = z.discriminatedUnion("type", [
  /* ---- 阶段类：告诉用户系统进行到哪了 ---- */

  /** 必须在 800ms 内送达，用户不能面对空白等待 */
  z.object({
    type: z.literal("run_started"),
    runId: z.string(),
    asOfDate: z.string().date(),
  }),

  /** 相对时间被确定性解析成了什么。解析不出时间表达时不发，不报错 */
  z.object({
    type: z.literal("time_resolved"),
    /** 用户原话里的时间表达，如 "近30天" */
    expression: z.string(),
    /** 解析出的绝对区间（闭开） */
    from: z.string(),
    to: z.string(),
    /** 回显给用户的文案："已理解为 2026-08-02 ~ 2026-08-31" */
    display: z.string(),
  }),

  /** 只推表名和命中的 few-shot id；schema 全文进 steps 表，不进事件 */
  z.object({
    type: z.literal("context_built"),
    tables: z.array(z.string()),
    fewshotIds: z.array(z.string()),
  }),

  /** 重试时再次推送，attempt 递增。前端并列保留、不覆盖，可对比 diff */
  z.object({
    type: z.literal("sql_generated"),
    attempt: z.number().int().positive(),
    sql: z.string(),
    /** 模型自报依据了哪些口径规则 */
    citedRules: z.array(RuleIdSchema),
  }),

  /** 口径 lint 结果。block 级违规后不会再有本 attempt 的 rows */
  z.object({
    type: z.literal("lint_result"),
    attempt: z.number().int().positive(),
    violations: z.array(LintViolationSchema),
  }),

  /* ---- 结果类 ---- */

  z.object({
    type: z.literal("rows"),
    columns: z.array(z.string()),
    rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))),
    /** 实际总行数（可能大于 rows.length，被截断时） */
    rowCount: z.number().int().nonnegative(),
    /** 超 1000 行被截断。行数正好等于上限也是体检判定「可疑形态」的依据之一 */
    truncated: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
  }),

  z.object({
    type: z.literal("verification"),
    checks: z.array(
      z.object({
        kind: VerificationCheckKindSchema,
        passed: z.boolean(),
        detail: z.string(),
      }),
    ),
    /** 空结果归因探针的输出：是哪个条件把数据滤没了 */
    emptyReason: z
      .object({
        suspectCondition: z.string(),
        countIfRelaxed: z.number().int(),
      })
      .optional(),
    /** 不完整周期：趋势末点落在未闭合周期，前端画虚线 */
    incompletePeriod: z
      .object({
        lastPointLabel: z.string(),
        watermark: z.string(),
      })
      .optional(),
  }),

  /**
   * 口径回执卡片。载荷完全由代码从 AST + 规则表生成，模型碰不到它 ——
   * 这是它可信的全部理由。fullyTranslated = false 时答案必须落「未核验」。
   */
  z.object({
    type: z.literal("receipt"),
    scope: z.string(),
    filters: z.array(z.string()),
    method: z.string(),
    dataUntil: z.string(),
    coverage: z.string(),
    fullyTranslated: z.boolean(),
  }),

  /** unverified/refused 时 reasons 必须非空；refused 时必须给澄清选项 */
  z.object({
    type: z.literal("state"),
    verdict: VerdictSchema,
    reasons: z.array(z.string()),
    clarifications: z
      .array(
        z.object({
          label: z.string(),
          description: z.string(),
        }),
      )
      .optional(),
  }),

  z.object({
    type: z.literal("chart"),
    spec: ChartSpecSchema,
  }),

  /** 结论文字的增量片段，前端拼接实现打字机效果。结论里禁止出现数字断言 */
  z.object({
    type: z.literal("text_delta"),
    delta: z.string(),
  }),

  /* ---- 终止类 ---- */

  z.object({
    type: z.literal("error"),
    code: ErrorCodeSchema,
    message: z.string(),
    detail: z.string().optional(),
  }),

  /**
   * 任何分支下都必发 —— 包括 UNSAFE_SQL、TIMEOUT、BUDGET_EXCEEDED、
   * 拒答、客户端 abort。前端不存在卡在 loading 的路径。
   */
  z.object({
    type: z.literal("done"),
    runId: z.string(),
    elapsedMs: z.number().int().nonnegative(),
    attempts: z.number().int().positive(),
    llmCalls: z.number().int().nonnegative(),
    tokens: z.object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
    }),
    costCny: z.number(),
  }),
]);

export type CaliberEvent = z.infer<typeof CaliberEventSchema>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type Verdict = z.infer<typeof VerdictSchema>;
export type LintViolation = z.infer<typeof LintViolationSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;

/* ------------------------------------------------------------------ */
/* SSE 序列化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把一个事件编码成 SSE 帧。约定：event 行只写类型名，data 行是完整 JSON
 * （含 type 字段，方便客户端在只拿得到 data 时也能分辨类型）。
 */
export function encodeSseEvent(event: CaliberEvent): string {
  const json = JSON.stringify(event);
  return `event: ${event.type}\ndata: ${json}\n\n`;
}

/**
 * 从 SSE 帧的 data 行解析并校验事件。解析失败抛错而不是返回 null ——
 * 事件流中出现非法载荷属于契约破坏，静默吞掉会把问题推迟到更难查的地方。
 */
export function parseSseData(raw: string): CaliberEvent {
  return CaliberEventSchema.parse(JSON.parse(raw));
}

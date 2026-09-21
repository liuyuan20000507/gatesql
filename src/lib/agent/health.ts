/**
 * 步骤 8「结果体检」的纯分析（从 loop.ts 抽出）。
 *
 * 职责边界：只**分析**结果并回传事实（checks / 归因 / 该不该 warn），
 * 不做任何状态突变——finalStatus / warnSeen / verdictReasons 的写入、
 * verification 事件的 emit 全部留在调用方（loop.ts），保持状态流转集中、可读。
 *
 * 四项检查（docs/05 步骤 8）：
 *  (a) 空结果：0 行 → emptyResultFlag；聚合对空集返回「一行 NULL」也算空 → warn
 *  (b) 截断嫌疑：行数 >= LIMIT 上限
 *  (c) 归因探针：空结果时逐类放宽条件跑 COUNT，定位「谁把数据滤没了」
 *  (d) 量级校验：金额聚合 vs 同范围无过滤控制总数，占比 >100% 或 <1% 标红
 */

import { checkMagnitude } from "@/lib/sql/magnitude";
import { buildEmptyResultProbes } from "@/lib/sql/probe";

export interface HealthCheck {
  kind: "empty_result" | "suspicious_shape" | "data_watermark" | "magnitude";
  passed: boolean;
  detail: string;
}

export interface EmptyReason {
  suspectCondition: string;
  countIfRelaxed: number;
}

export interface HealthOutcome {
  checks: HealthCheck[];
  emptyReason?: EmptyReason;
  /** 0 行结果：调用方据此设 finalStatus="EMPTY_RESULT" */
  emptyResultFlag: boolean;
  /** 空集聚合 或 量级 fail：调用方据此设 warnSeen=true（答案降级未核验） */
  warnSeen: boolean;
  /** 空集聚合专属：调用方据此设 warnReasoned=true（已有专属理由，步骤 9 不再补泛化理由） */
  warnReasoned: boolean;
  /** 需按序 push 进 verdictReasons 的人话理由 */
  reasons: string[];
}

export interface HealthInput {
  success: { columns: string[]; rows: unknown[][] };
  lastSql: string | null;
  maxRows: number;
  shopDbPath: string;
  execute: (sql: string) => Promise<{ rows: unknown[][] }>;
}

export async function runHealthChecks(input: HealthInput): Promise<HealthOutcome> {
  const checks: HealthCheck[] = [];
  const reasons: string[] = [];
  let emptyResultFlag = false;
  let warnSeen = false;
  let warnReasoned = false;

  const { success } = input;
  // 聚合对空集返回「一行 NULL」而不是 0 行 —— 两种形态都算空（docs/05 步骤 8(b)）
  const emptyAggregate = success.rows.length === 1 && success.rows[0].every((v) => v === null);
  if (success.rows.length === 0) {
    emptyResultFlag = true;
    checks.push({ kind: "empty_result", passed: false, detail: "查询返回 0 行" });
  } else if (emptyAggregate) {
    checks.push({ kind: "empty_result", passed: true, detail: "结果非空" });
    checks.push({ kind: "suspicious_shape", passed: false, detail: "聚合结果为单个 NULL：范围内 0 行，聚合建立在空集上" });
    warnSeen = true; // 单个 NULL 的「0」绝不能以已核验姿态交付
    warnReasoned = true;
    reasons.push("聚合建立在空集上：本范围内没有匹配数据，数字（NULL/0）不代表业务为零");
  } else {
    checks.push({ kind: "empty_result", passed: true, detail: "结果非空" });
  }

  if (success.rows.length >= input.maxRows) {
    checks.push({ kind: "suspicious_shape", passed: false, detail: "行数到达 LIMIT 上限，可能被静默截断" });
  } else {
    checks.push({ kind: "suspicious_shape", passed: true, detail: "未见截断" });
  }

  // 5E：空结果归因探针 —— 每次只放宽一类条件重跑 COUNT（代码生成，≤4 条），
  // 第一个「放宽后就有数据」的条件类即元凶；全部放宽仍为 0 就如实说没有数据
  let emptyReason: EmptyReason | undefined;
  if ((success.rows.length === 0 || emptyAggregate) && input.lastSql) {
    for (const probe of buildEmptyResultProbes(input.lastSql)) {
      try {
        const r = await input.execute(probe.sql);
        const n = Number(r.rows[0]?.[0] ?? 0);
        if (n > 0) {
          emptyReason = { suspectCondition: probe.label, countIfRelaxed: n };
          break;
        }
        if (probe.label === "全部过滤条件") {
          emptyReason = { suspectCondition: probe.label, countIfRelaxed: 0 };
        }
      } catch {
        // 探针自身失败：放弃归因，不编原因
      }
    }
    if (emptyReason && emptyReason.countIfRelaxed > 0) {
      reasons.push(
        `该口径下没有数据；单独放宽「${emptyReason.suspectCondition}」后可见 ${emptyReason.countIfRelaxed} 行`,
      );
    }
  }

  // 8(d)：量级校验 —— 金额聚合结果对比「去业务过滤、留时间范围」的控制总数，
  // 占比 >100% 或 <1% 标红降级。skip（非金额/分组/空集形态）时静默，不越界空集体检。
  if (input.lastSql) {
    const mag = checkMagnitude({
      sql: input.lastSql,
      columns: success.columns,
      rows: success.rows,
      shopDbPath: input.shopDbPath,
    });
    if (mag.status === "fail") {
      checks.push({ kind: "magnitude", passed: false, detail: mag.detail });
      warnSeen = true;
    }
  }

  return { checks, emptyReason, emptyResultFlag, warnSeen, warnReasoned, reasons };
}

import { DatabaseSync } from "node:sqlite";

import { applyBudget, resolveMode } from "@/lib/agent/llm";
import { getTodayCostCny, openAppDb } from "@/lib/db/app";
import { getConfig } from "@/lib/env";

/**
 * GET /api/health（docs/03 第六节）。
 * 无 key 演示与 Docker 健康检查都依赖它：llmMode=replay 且未显式配置时，
 * 说明系统处于「零外部依赖」模式。
 */
export function GET() {
  const env = getConfig();
  let dbConnected = false;
  try {
    const shop = new DatabaseSync(env.SHOP_DB_PATH, { readOnly: true });
    try {
      shop.prepare("SELECT 1 AS ok").get();
      dbConnected = true;
    } finally {
      shop.close();
    }
  } catch {
    dbConnected = false;
  }

  let dailyBudgetRemaining = -1; // -1 = 不限
  let spentToday = 0;
  if (env.DAILY_BUDGET_CNY >= 0) {
    const appDb = openAppDb(env.APP_DB_PATH);
    try {
      spentToday = getTodayCostCny(appDb);
      dailyBudgetRemaining = Math.max(0, env.DAILY_BUDGET_CNY - spentToday);
    } finally {
      appDb.close();
    }
  }

  return Response.json({
    status: dbConnected ? "ok" : "degraded",
    dbConnected,
    // llmMode 与 callLlm 同一判定：预算耗尽时如实显示 replay（护栏已降级）
    llmMode: applyBudget(resolveMode(env), spentToday, env.DAILY_BUDGET_CNY),
    dailyBudgetRemaining,
  });
}

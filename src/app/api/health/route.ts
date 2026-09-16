import { DatabaseSync } from "node:sqlite";

import { resolveMode } from "@/lib/agent/llm";
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
  if (env.DAILY_BUDGET_CNY >= 0) {
    const appDb = openAppDb(env.APP_DB_PATH);
    try {
      dailyBudgetRemaining = Math.max(0, env.DAILY_BUDGET_CNY - getTodayCostCny(appDb));
    } finally {
      appDb.close();
    }
  }

  return Response.json({
    status: dbConnected ? "ok" : "degraded",
    dbConnected,
    llmMode: resolveMode(env),
    dailyBudgetRemaining,
  });
}

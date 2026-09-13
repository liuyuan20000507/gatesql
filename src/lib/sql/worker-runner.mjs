// worker 线程入口（纯 JS，不依赖任何 TS 别名——被 executor.ts 以 workerData 拉起）。
// 职责：打开只读连接，执行单条 SELECT，把结果回传主线程。
// 安全：readOnly 打开（连接层）+ authorizer 按动作码拒绝写（引擎层），
//       与 guard.ts 的策略一致；语句层白名单已由上游 guardSql 把关。

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const ACTION_ALLOWED = new Set([20, 21, 31]); // READ / SELECT / FUNCTION

const db = new DatabaseSync(workerData.dbPath, { readOnly: true });
db.setAuthorizer((action) => (ACTION_ALLOWED.has(action) ? 0 : 1));

parentPort.on("message", (msg) => {
  const startedAt = Date.now();
  try {
    const stmt = db.prepare(msg.sql);
    const objects = stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    const rows = objects.map((o) => columns.map((c) => (o[c] === undefined ? null : (o[c] ?? null))));
    parentPort.postMessage({ ok: true, columns, rows, elapsedMs: Date.now() - startedAt });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
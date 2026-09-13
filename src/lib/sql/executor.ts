/**
 * worker 执行器：把 SQL 放进 worker 线程跑，主线程自己计时。
 *
 * 为什么必须 worker（docs/07-security.md 第 7 层）：node:sqlite 是同步 API，
 * 一条慢查询会在 worker 里占住线程；若在主线程跑会冻住整个进程的所有 SSE
 * 连接。worker 隔离保的是服务可用性。
 *
 * 为什么超时不依赖 worker.terminate()：实测它无法回收卡在同步原生调用里的
 * worker。所以超时策略是「主线程放弃等待 + 标记该 worker 已污染并弃用 +
 * 下次查询重建」。
 */

import { Worker } from "node:worker_threads";

import type { RunCell } from "@/lib/reduce-events";

export class QueryTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`查询超过 ${timeoutMs}ms 未返回`);
    this.name = "QueryTimeoutError";
  }
}

export interface QueryResult {
  columns: string[];
  rows: RunCell[][];
  /** prepare().all() 实际读取的行数（guard 已在 SQL 里注入 LIMIT） */
  rowCount: number;
  elapsedMs: number;
}

interface WorkerOutcome {
  ok?: boolean;
  columns?: string[];
  rows?: RunCell[][];
  error?: string;
  elapsedMs?: number;
}

export class SqlExecutor {
  private worker: Worker | null = null;
  /** 学习型参数：一次超时后，重建 worker 的成本由调用频率摊薄 */
  private dirty = false;

  constructor(
    private readonly dbPath: string,
    private readonly timeoutMs = 5000,
  ) {}

  private getWorker(): Worker {
    if (this.worker && !this.dirty) return this.worker;
    // 弃用旧 worker（不等待它退出），spawn 新的
    if (this.worker) {
      void this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    const url = new URL("./worker-runner.mjs", import.meta.url);
    this.worker = new Worker(url, { workerData: { dbPath: this.dbPath } });
    // 实测：卡在同步原生调用里的 worker，terminate() 永远不 resolve，
    // 甚至会让 process.exit 失效。unref 保证主进程不会被这样的 worker 绑架；
    // 在途请求的副作用由 promise 持有，消息仍会送达。
    this.worker.unref();
    this.dirty = false;
    return this.worker;
  }

  async execute(sql: string): Promise<QueryResult> {
    const startedAt = Date.now();
    const worker = this.getWorker();

    const result = await new Promise<WorkerOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时：放弃等待，标记污染，由下一次调用重建 worker
        this.dirty = true;
        reject(new QueryTimeoutError(this.timeoutMs));
      }, this.timeoutMs);

      const onError = (err: Error) => {
        clearTimeout(timer);
        this.dirty = true;
        reject(err);
      };
      const onMessage = (msg: WorkerOutcome) => {
        clearTimeout(timer);
        resolve(msg);
      };

      worker.once("message", onMessage);
      worker.once("error", onError);
      worker.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("worker 意外退出"));
      });
      worker.postMessage({ sql });
    });

    if (!result.ok) {
      throw new Error(result.error ?? "worker 返回空结果");
    }
    return {
      columns: result.columns ?? [],
      rows: result.rows ?? [],
      rowCount: result.rows?.length ?? 0,
      elapsedMs: result.elapsedMs ?? Date.now() - startedAt,
    };
  }

  close(): void {
    if (this.worker) {
      void this.worker.terminate().catch(() => {});
      this.worker = null;
    }
  }
}
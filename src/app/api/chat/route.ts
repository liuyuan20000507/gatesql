import { NextRequest, NextResponse } from "next/server";

import { runAgent } from "@/lib/agent/loop";
import { appendEvent, openAppDb } from "@/lib/db/app";
import { ChatRequestSchema, encodeSseEvent } from "@/lib/events";
import type { CaliberEvent } from "@/lib/events";

/**
 * /api/chat —— 真 agent 入口（第 2 周起）。
 *
 * 职责只有三件：校验请求 → 让 runAgent 干活 → 把事件流式编码返回。
 * runAgent（loop.ts）自行管理 runId、app.db 与执行 trace；
 * 本文件只负责补一层「把事件同时落库到 events 表」，供 /runs 回放。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export async function POST(req: NextRequest) {
  const body = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json({ error: "请求体不合法", issues: body.error.issues }, { status: 400 });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const sentEvents: CaliberEvent[] = [];

      const enqueue = (event: CaliberEvent) => {
        sentEvents.push(event);
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // 已关闭或已 abort，竞态下忽略
        }
      };

      // 客户端关页 / StrictMode 双发后的那次 abort：立即停止推送
      req.signal.addEventListener("abort", close);

      try {
        await runAgent({
          question: body.data.question,
          asOfDate: body.data.asOfDate ?? undefined,
          emit: enqueue,
          // loop 内部自行落 app.db 的 steps；这里不重复记 trace
          trace: () => {},
        });
      } catch (err) {
        enqueue({ type: "error", code: "LLM_ERROR", message: err instanceof Error ? err.message : String(err) });
      } finally {
        // 事件落库（供 /runs 历史页回放）；runId 取自 run_started
        const runId = sentEvents.find((e) => e.type === "run_started")?.runId;
        if (runId) {
          const db = openAppDb();
          try {
            for (const e of sentEvents) appendEvent(db, runId, e);
          } finally {
            db.close();
          }
        }
        close();
      }
    },
  });

  return new NextResponse(stream, { headers: SSE_HEADERS });
}
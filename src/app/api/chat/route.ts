import { NextRequest, NextResponse } from "next/server";

import { ChatRequestSchema, encodeSseEvent } from "@/lib/events";
import { buildStubRun } from "@/lib/fixtures/stub-run";
import { saveRunEvents } from "@/lib/fixtures/stub-store";

/**
 * 第 1 周的桩接口：按契约顺序推送剧本事件。
 *
 * 第 2 周把 buildStubRun 换成真 agent 的事件流，本文件其余部分
 * （请求校验、SSE 编码、abort 处理、响应头）原样保留。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STUB_EVENT_INTERVAL_MS = 300;

export async function POST(req: NextRequest) {
  const body = ChatRequestSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { error: "请求体不合法", issues: body.error.issues },
      { status: 400 },
    );
  }

  const runId = `r_${crypto.randomUUID().slice(0, 8)}`;
  const script = buildStubRun(runId);
  // 第 2 周这里换成「边执行边落 app.db 的 events 表」，接口不变
  saveRunEvents(runId, script);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      // 客户端关页面（或 StrictMode 双发后的那次 abort）时立刻停止，
      // 不再往已关闭的流里写
      req.signal.addEventListener("abort", () => {
        try {
          controller.close();
        } catch {
          // controller 可能已被 close，无需处理
        }
      });

      for (const event of script) {
        if (req.signal.aborted) break;
        await new Promise((r) => setTimeout(r, STUB_EVENT_INTERVAL_MS));
        controller.enqueue(encoder.encode(encodeSseEvent(event)));
      }

      try {
        controller.close();
      } catch {
        // abort 竞态：流可能已关闭
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

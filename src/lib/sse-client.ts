/**
 * SSE 客户端：fetch + ReadableStream 手动解析。
 *
 * 不用 EventSource —— 它只能发 GET 且不能带自定义头，而 /api/chat
 * 需要 POST + JSON body。解析规则与 docs/03-api-contract.md 的帧格式对应：
 * 每帧 = "event: <type>\n" + "data: <json>\n\n"。
 */

import { parseSseData } from "@/lib/events";
import type { GateSqlEvent } from "@/lib/events";

export async function postChatStream(
  url: string,
  body: unknown,
  onEvent: (event: GateSqlEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`SSE 请求失败: HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // 帧以空行分隔；最后一段可能不完整，留到下一轮
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      onEvent(parseSseData(dataLine.slice("data: ".length)));
    }
  }
}

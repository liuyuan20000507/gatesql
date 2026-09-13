/**
 * 第 1 周的临时事件存储：进程内 Map。
 *
 * 两个注意点：
 * 1. 挂在 globalThis 上 —— Next 把每个路由编译成独立的模块图，
 *    模块顶层 new Map() 会在 route.ts 和 page.tsx 各实例化一份，
 *    写进 A 份、从 B 份读，永远查不到。globalThis 在同一进程内全局唯一。
 *    （这也是 Next 官方文档推荐的单例写法，Prisma client 同理）
 * 2. dev server 重启后丢失 —— 第 1 周如实接受，历史页会显示提示。
 *    第 2 周换成写入 app.db 的 events 表（见 docs/04-data-model.md），
 *    本文件的 get/set 接口保持不变，消费方无感。
 */

import type { CaliberEvent } from "@/lib/events";

const globalStore = globalThis as unknown as {
  __caliberStubStore?: Map<string, CaliberEvent[]>;
};

const store = (globalStore.__caliberStubStore ??= new Map<string, CaliberEvent[]>());

export function saveRunEvents(runId: string, events: CaliberEvent[]): void {
  store.set(runId, events);
}

export function getRunEvents(runId: string): CaliberEvent[] | null {
  return store.get(runId) ?? null;
}

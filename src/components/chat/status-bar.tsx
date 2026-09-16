import { Badge } from "@/components/ui/badge";
import type { RunPhase } from "@/lib/reduce-events";

const PHASE_TEXT: Record<RunPhase, string> = {
  understanding: "正在理解问题",
  sql: "已生成 SQL",
  executing: "执行查询",
  verifying: "结果体检",
  summarizing: "生成结论",
  done: "已完成",
  failed: "失败",
};

/** 阶段顺序，用于画进度点 */
const ORDER: RunPhase[] = ["understanding", "sql", "executing", "verifying", "summarizing"];

export function StatusBar({
  phase,
  timeDisplay,
  verdict,
}: {
  phase: RunPhase;
  timeDisplay: string | null;
  verdict: "verified" | "unverified" | "refused" | null;
}) {
  const currentIndex = ORDER.indexOf(phase as (typeof ORDER)[number]);
  const isTerminal = phase === "done" || phase === "failed";

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {ORDER.map((p, i) => (
        <span key={p} className="flex items-center gap-2">
          {i > 0 && <span className="text-neutral-300">→</span>}
          <span
            className={
              isTerminal || i < currentIndex
                ? "text-neutral-600"
                : i === currentIndex
                  ? "font-medium text-neutral-900"
                  : "text-neutral-300"
            }
          >
            {PHASE_TEXT[p]}
          </span>
        </span>
      ))}

      {isTerminal && (
        <Badge variant={phase === "done" ? "secondary" : "destructive"}>{PHASE_TEXT[phase]}</Badge>
      )}

      {verdict && (
        <span
          className={`stamp text-xs ${
            verdict === "refused" ? "stamp-red" : verdict === "unverified" ? "stamp-amber" : ""
          }`}
        >
          {verdict === "verified" ? "已核验" : verdict === "unverified" ? "未核验" : "已拒答"}
        </span>
      )}

      {timeDisplay && <span className="ml-auto text-xs text-neutral-500">{timeDisplay}</span>}
    </div>
  );
}

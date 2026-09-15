import { Badge } from "@/components/ui/badge";
import { wordDiff } from "@/lib/sql/diff";
import type { SqlAttempt } from "@/lib/reduce-events";

/** diff 单栏渲染：same 灰、del 红底删除线、ins 绿底 */
function DiffPane({ segments, side }: { segments: ReturnType<typeof wordDiff>["left"]; side: "left" | "right" }) {
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 text-[11px] leading-relaxed text-neutral-600">
      <code>
        {segments.map((seg, i) =>
          seg.kind === "same" ? (
            <span key={i}>{seg.text}</span>
          ) : (
            <span
              key={i}
              className={
                seg.kind === "del" && side === "left"
                  ? "rounded-sm bg-red-100 text-red-700 line-through"
                  : seg.kind === "ins" && side === "right"
                    ? "rounded-sm bg-green-100 text-green-800"
                    : "hidden" // 左栏不显示纯新增段，右栏不显示纯删除段
              }
            >
              {seg.text}
            </span>
          ),
        )}
      </code>
    </pre>
  );
}

/**
 * SQL 尝试列表，并列保留、不覆盖。第 1 次被拦 + 第 2 次修复的
 * 左右对比是招牌演示，所以每次尝试都是独立一块，而不是只显示最后一次。
 */
export function SqlAttemptsPanel({ attempts }: { attempts: SqlAttempt[] }) {
  if (attempts.length === 0) return null;
  const latest = attempts[attempts.length - 1];

  return (
    <div className="space-y-3">
      {attempts.map((attempt, idx) => {
        const blocked = attempt.lint.some((v) => v.level === "block");
        const warned = !blocked && attempt.lint.some((v) => v.level === "warn");
        const prev = idx > 0 ? attempts[idx - 1] : null;
        const diff = prev ? wordDiff(prev.sql, attempt.sql) : null;

        return (
          <div
            key={attempt.attempt}
            className={`rounded-lg border p-3 ${
              attempt.attempt === latest.attempt
                ? "border-neutral-900"
                : blocked
                  ? "border-red-200 bg-red-50/50"
                  : "border-neutral-200"
            }`}
          >
            <div className="mb-2 flex items-center gap-2 text-sm">
              <span className="font-medium">第 {attempt.attempt} 次尝试</span>
              {blocked && <Badge variant="destructive">被口径规则拦下</Badge>}
              {warned && <Badge className="bg-amber-100 text-amber-800">口径警告</Badge>}
              {attempt.attempt === latest.attempt && !blocked && !warned && (
                <Badge className="bg-green-100 text-green-800">通过检查</Badge>
              )}
            </div>

            {diff && (
              <div className="mb-2">
                <p className="mb-1 text-[11px] text-neutral-500">与第 {prev?.attempt} 次相比（左：旧 / 右：新）</p>
                <div className="grid grid-cols-2 gap-2">
                  <DiffPane segments={diff.left} side="left" />
                  <DiffPane segments={diff.right} side="right" />
                </div>
              </div>
            )}

            <pre className="overflow-x-auto rounded bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-100">
              <code>{attempt.sql}</code>
            </pre>

            {attempt.lint.map((v) => (
              <p key={v.ruleId} className="mt-2 text-xs text-red-700">
                规则 {v.ruleId}：缺失 <code className="rounded bg-red-100 px-1">{v.missingPredicate}</code>
                {" —— "}
                {v.suggestion}
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}

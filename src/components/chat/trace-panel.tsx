import { Badge } from "@/components/ui/badge";
import type { StepRecord } from "@/lib/db/app";

/**
 * 执行追踪面板（4G，docs/05 第五节）：把 steps 表里模型视角的原始记录铺开 ——
 * 每次 LLM 调用的完整 prompt/completion、guard/lint/EQP 各检查的结论与耗时。
 *
 * 纯服务端组件：全部用原生 <details> 折叠，无客户端 JS。
 * 这是「trace 存在的首要理由」的兑现：事后能复现「模型当时看到了什么、为什么写错」。
 */

const KIND_LABEL: Record<string, string> = {
  llm_call: "模型调用",
  guard: "安全检查",
  lint: "口径检查",
  eqp: "代价预检",
  execute: "执行",
  verify: "结果体检",
  receipt: "口径回执",
};

function AttrBlock({ title, body }: { title: string; body: string }) {
  return (
    <details className="mt-1 rounded border border-neutral-200 bg-neutral-50">
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium text-neutral-600">
        {title}
      </summary>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all px-2 py-2 text-[11px] leading-relaxed text-neutral-700">
        {body}
      </pre>
    </details>
  );
}

function attrString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function TracePanel({ steps }: { steps: StepRecord[] }) {
  if (steps.length === 0) return null;

  return (
    <details className="rounded-lg border border-neutral-200 bg-white">
      <summary className="cursor-pointer select-none p-3 text-sm font-medium text-neutral-700">
        执行追踪 · {steps.length} 步（模型视角：完整 prompt / 各检查结论 / 各阶段耗时）
      </summary>
      <ol className="space-y-2 border-t border-neutral-100 p-3">
        {steps.map((s, i) => {
          const a = s.attributes;
          const phase = attrString(a.phase) ?? attrString(a.stage);
          const prompt = attrString(a.prompt);
          const completion = attrString(a.completion);
          const inTok = typeof a.inputTokens === "number" ? a.inputTokens : null;
          const outTok = typeof a.outputTokens === "number" ? a.outputTokens : null;
          const violations = Array.isArray(a.violations) ? (a.violations as Array<Record<string, unknown>>) : null;
          // steps.status 记的是「检查本身是否执行成功」；SQL 被规则拦下要在 UI 上说话
          const blocked = s.kind === "lint" && !!violations?.some((v) => v.level === "block");
          const bad = s.status === "failed" || s.status === "rejected" || blocked;
          return (
            <li key={`${s.kind}-${s.seq}-${i}`} className="rounded-md border border-neutral-200 p-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-neutral-400">#{s.seq}</span>
                <Badge variant="secondary">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
                {phase && <Badge variant="outline">{phase === "self_check" ? "自检审计" : phase}</Badge>}
                <span className={blocked ? "text-red-600" : bad ? "text-amber-600" : "text-emerald-600"}>
                  {blocked ? "已拦截" : bad ? "拒绝/失败" : "通过"}
                </span>
                {s.durationMs !== null && <span className="text-neutral-400">{s.durationMs} ms</span>}
                {inTok !== null && (
                  <span className="text-neutral-400">
                    in {inTok} / out {outTok}
                  </span>
                )}
              </div>
              {violations && violations.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs text-amber-700">
                  {violations.map((v, i) => (
                    <li key={i}>
                      {String(v.ruleId)}（{String(v.level)}）：{String(v.missingPredicate)}
                    </li>
                  ))}
                </ul>
              )}
              {attrString(a.detail) && <p className="mt-1 text-xs text-red-700">{attrString(a.detail)}</p>}
              {attrString(a.reason) && <p className="mt-1 text-xs text-amber-700">{attrString(a.reason)}</p>}
              {prompt && <AttrBlock title={`发出的完整 Prompt（${prompt.length} 字符）`} body={prompt} />}
              {completion && <AttrBlock title="模型原始回复" body={completion} />}
            </li>
          );
        })}
      </ol>
    </details>
  );
}

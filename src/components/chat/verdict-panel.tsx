export interface Clarification {
  label: string;
  description: string;
  /** 词典选项的追加话术；有此字段 = 点击后自动重问（多轮澄清），无则退回填输入框 */
  clarifyPhrase?: string;
}

function ClarifyItem(props: { c: Clarification; onClarify?: (c: Clarification) => void }) {
  const body = (
    <span>
      <span className="font-medium text-red-900">{props.c.label}</span>
      <span className="ml-2 text-neutral-600">{props.c.description}</span>
    </span>
  );
  if (props.onClarify) {
    return (
      <button
        type="button"
        onClick={() => props.onClarify?.(props.c)}
        className="block w-full rounded border border-red-300 bg-white px-2 py-1.5 text-left text-xs hover:bg-red-50"
      >
        {body}
      </button>
    );
  }
  return <div className="rounded border border-red-300 bg-white px-2 py-1.5 text-xs">{body}</div>;
}

export function VerdictPanel(props: {
  verdict: "verified" | "unverified" | "refused" | null;
  reasons: string[];
  clarifications: Clarification[];
  onClarify?: (c: Clarification) => void;
}) {
  if (props.verdict === "refused") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
        <div className="mb-2 flex items-center gap-2">
          <span className="stamp stamp-red text-xs">已拒答</span>
          <span className="text-xs text-red-700">
            {props.clarifications.length > 0 ? "这道题可以换个问法继续：" : "这个口径下不给数字。"}
          </span>
        </div>
        <ul className="mb-2 list-disc pl-5 text-xs text-red-800">
          {props.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {props.clarifications.length > 0 && (
          <div className="mt-2 space-y-2">
            <p className="text-xs font-medium text-red-800">澄清选项 / 可查内容：</p>
            {props.clarifications.map((c) => (
              <ClarifyItem key={c.label} c={c} onClarify={props.onClarify} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (props.verdict === "unverified" && props.reasons.length > 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
        <div className="mb-2">
          <span className="stamp stamp-amber text-xs">未核验</span>
          <span className="ml-2 text-xs text-amber-800">以下原因导致本次结果未通过全部核验：</span>
        </div>
        <ul className="list-disc pl-5 text-xs text-amber-800">
          {props.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

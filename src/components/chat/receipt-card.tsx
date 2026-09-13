import type { RunState } from "@/lib/reduce-events";

/**
 * 口径回执卡片。内容来自 receipt 事件 —— 由代码从 AST 和规则表机械生成，
 * 模型碰不到它，所以它在结构上不可能撒谎。卡片上把这一点写出来，
 * 是给业务人员的信任说明。
 */
export function ReceiptCard({ receipt }: { receipt: NonNullable<RunState["receipt"]> }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-400 bg-neutral-50 p-3 text-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">口径回执</span>
        <span className="text-xs text-neutral-500">由代码生成，模型不可见</span>
      </div>
      <dl className="space-y-1 text-xs leading-relaxed">
        <div>
          <dt className="inline font-medium text-neutral-600">统计范围： </dt>
          <dd className="inline">{receipt.scope}</dd>
        </div>
        {receipt.filters.map((f) => (
          <div key={f}>
            <dt className="inline font-medium text-neutral-600">口径： </dt>
            <dd className="inline">{f}</dd>
          </div>
        ))}
        <div>
          <dt className="inline font-medium text-neutral-600">计算方式： </dt>
          <dd className="inline">{receipt.method}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-neutral-600">数据截止： </dt>
          <dd className="inline">{receipt.dataUntil}</dd>
        </div>
        <div>
          <dt className="inline font-medium text-neutral-600">参与计算： </dt>
          <dd className="inline">{receipt.coverage}</dd>
        </div>
      </dl>
    </div>
  );
}

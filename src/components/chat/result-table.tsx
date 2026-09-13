import type { ResultTable, RunCell } from "@/lib/reduce-events";

const numberFormat = new Intl.NumberFormat("zh-CN");

function renderCell(cell: RunCell) {
  if (cell === null) {
    // NULL 显式渲染为灰色，而不是空白 —— 空白会被读成 0 或「没数据」
    return <span className="text-neutral-400">NULL</span>;
  }
  if (typeof cell === "number") {
    return <span className="tabular-nums">{numberFormat.format(cell)}</span>;
  }
  if (typeof cell === "boolean") {
    return cell ? "是" : "否";
  }
  return cell;
}

export function ResultTable({ table }: { table: ResultTable }) {
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-neutral-600">
            <tr>
              {table.columns.map((col) => (
                <th key={col} className="px-3 py-2 font-medium">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i} className="border-t border-neutral-100">
                {row.map((cell, j) => (
                  <td key={j} className="px-3 py-1.5">
                    {renderCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-xs text-neutral-500">
        共 {table.rowCount} 行，耗时 {table.elapsedMs} ms
        {table.truncated && <span className="text-amber-600">（已截断，仅显示前 1000 行）</span>}
      </p>
    </div>
  );
}

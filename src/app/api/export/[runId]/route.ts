import { getEventsForRun, openAppDb } from "@/lib/db/app";
import { toCsvWithBom } from "@/lib/csv";

/**
 * GET /api/export/[runId]（6E）：把一次 run 的结果表格导出为带 UTF-8 BOM 的 CSV。
 * BOM 使 GBK 代码页机器上的 Excel 正确识别中文（roadmap 6E 验收标准）。
 */
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const db = openAppDb();
  try {
    const events = getEventsForRun(db, runId);
    // 取最后一次 rows 事件（成功 run 只有一行结果；防御性取末尾）
    const rowsEvent = [...events].reverse().find((e): e is Extract<typeof e, { type: "rows" }> => e.type === "rows");
    if (!rowsEvent) {
      return Response.json({ error: "该 run 没有可导出的结果表格" }, { status: 404 });
    }
    const csv = toCsvWithBom(rowsEvent.columns, rowsEvent.rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gatesql-${runId}.csv"`,
      },
    });
  } finally {
    db.close();
  }
}

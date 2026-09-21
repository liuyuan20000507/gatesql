/**
 * CSV 导出（6E）：RFC 4180 转义 + UTF-8 BOM + 公式注入防护。
 *
 * BOM（U+FEFF）：GBK 代码页机器上的 Excel 打开无 BOM 的 UTF-8 文件会按 ANSI
 * 解码，中文全部乱码——BOM 是 Excel 识别 UTF-8 的唯一可靠信号（roadmap 6E 验收）。
 *
 * 公式注入（CSV injection）：以 = + @ 或制表/回车开头的单元格会被 Excel 当作
 * 公式执行（如 =cmd|' /C calc'!A0）——非纯数字的此类值统一加前缀 ' 使其成为
 * 文本；纯数字（含负数/小数/科学计数）保持原样，不破坏数值类型。
 */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;
const PURE_NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
/** UTF-8 BOM：必须出现在文件第一个字节（EF BB BF） */
const UTF8_BOM = "\uFEFF";

export function csvEscapeCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  const guarded = !PURE_NUMBER.test(s) && FORMULA_PREFIX.test(s) ? `'${s}` : s;
  return `"${guarded.replace(/"/g, '""')}"`;
}

export function toCsv(columns: string[], rows: unknown[][]): string {
  const lines = [columns.map(csvEscapeCell).join(",")];
  for (const row of rows) lines.push(row.map(csvEscapeCell).join(","));
  return lines.join("\r\n");
}

/** 带 UTF-8 BOM 的完整 CSV */
export function toCsvWithBom(columns: string[], rows: unknown[][]): string {
  return UTF8_BOM + toCsv(columns, rows);
}

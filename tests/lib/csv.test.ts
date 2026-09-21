import { describe, expect, it } from "vitest";

import { toCsv, toCsvWithBom } from "@/lib/csv";

describe("toCsv（6E：RFC 4180 转义 + 注入防护）", () => {
  it("基本拼接：表头 + 行", () => {
    const csv = toCsv(["category", "sales"], [["食品生鲜", 100]]);
    expect(csv).toBe('"category","sales"\r\n"食品生鲜","100"');
  });

  it("值含逗号/引号/换行 → 引号包裹 + 引号翻倍", () => {
    const csv = toCsv(["v"], [['a,b', 'he said "hi"', "line1\nline2"]]);
    expect(csv).toBe('"v"\r\n"a,b","he said ""hi""","line1\nline2"');
  });

  it("null/undefined → 空单元格", () => {
    const csv = toCsv(["a", "b"], [[null, undefined]]);
    expect(csv).toBe('"a","b"\r\n"",""');
  });

  it("公式注入：= 开头的值加前缀变文本", () => {
    const csv = toCsv(["v"], [["=SUM(A1:A2)"]]);
    expect(csv).toContain("'=SUM(A1:A2)");
  });

  it("公式注入：+ 和 @ 开头同样防护", () => {
    const csv = toCsv(["v"], [["+cmd", "@x"]]);
    expect(csv).toContain("'+cmd");
    expect(csv).toContain("'@x");
  });

  it("纯数字（含负数/小数）不加前缀，保持数值类型", () => {
    const csv = toCsv(["v"], [[-123, 3.14, "2026-08-05"]]);
    expect(csv).toContain('"-123"');
    expect(csv).toContain('"3.14"');
    expect(csv).toContain('"2026-08-05"'); // 日期不是数字，但也不以危险字符开头
    expect(csv).not.toContain("'-");
  });
});

describe("toCsvWithBom（6E 验收：Excel/GBK 中文不乱码）", () => {
  it("第一个字符必须是 U+FEFF BOM", () => {
    const csv = toCsvWithBom(["分类"], [["食品生鲜", 1]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // BOM 之后紧跟正常 CSV 内容
    expect(csv.slice(1)).toBe('"分类"\r\n"食品生鲜","1"');
  });

  it("UTF-8 编码后文件头三个字节是 EF BB BF", () => {
    const bytes = new TextEncoder().encode(toCsvWithBom(["分类"], []));
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

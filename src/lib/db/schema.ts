/**
 * 业务库 schema 读取（应用层专用）。
 *
 * 与 agent 的连接刻意区分：agent 的 SQL 走 guard 的只读连接（authorizer
 * 禁读内部表）；这里读 schema 用的是另一条独立连接，而且**只跑固定的
 * 预定义查询**（入参只有白名单表名/列名），绝不执行模型或用户产生的文本。
 */

import { DatabaseSync } from "node:sqlite";

export interface SchemaColumn {
  name: string;
  type: string;
  comment: string;
  distinct: number;
  nullRate: number;
  /** 低基数列（COUNT(DISTINCT) ≤ 20）的全部取值 */
  enumValues?: string[];
}

export interface SchemaTable {
  name: string;
  comment: string;
  rowCount: number;
  columns: SchemaColumn[];
}

const BUSINESS_TABLES = ["customers", "products", "orders", "order_items"];
const ENUM_MAX_CARDINALITY = 20;
const ENUM_MAX_VALUES = 20;

export function readShopSchema(dbPath: string): SchemaTable[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const comments = new Map<string, string>();
    for (const row of db.prepare("SELECT table_name, column_name, comment FROM _column_comments").all() as Array<{
      table_name: string;
      column_name: string;
      comment: string;
    }>) {
      comments.set(`${row.table_name}.${row.column_name}`, row.comment);
    }

    return BUSINESS_TABLES.map((tableName) => {
      const columns = db
        .prepare("SELECT name, type FROM pragma_table_info(?)")
        .all(tableName) as Array<{ name: string; type: string }>;
      const rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}"`).get() as { n: number }).n;

      const tableColumns = columns.map((col) => {
        const distinct = (
          db.prepare(`SELECT COUNT(DISTINCT "${col.name}") AS n FROM "${tableName}"`).get() as { n: number }
        ).n;
        const nulls = (
          db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}" WHERE "${col.name}" IS NULL`).get() as { n: number }
        ).n;

        let enumValues: string[] | undefined;
        if (distinct > 0 && distinct <= ENUM_MAX_CARDINALITY) {
          enumValues = (
            db
              .prepare(`SELECT DISTINCT "${col.name}" AS v FROM "${tableName}" ORDER BY 1 LIMIT ${ENUM_MAX_VALUES}`)
              .all() as Array<{ v: unknown }>
          )
            .filter((r) => r.v !== null)
            .map((r) => String(r.v));
        }

        return {
          name: col.name,
          type: col.type,
          comment: comments.get(`${tableName}.${col.name}`) ?? "",
          distinct,
          nullRate: rowCount > 0 ? nulls / rowCount : 0,
          ...(enumValues ? { enumValues } : {}),
        };
      });

      return {
        name: tableName,
        comment: comments.get(`${tableName}._table`) ?? "",
        rowCount,
        columns: tableColumns,
      };
    });
  } finally {
    db.close();
  }
}
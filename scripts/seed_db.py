"""
生成示例数据库 data/shop.db —— 一个电商销售场景。

用法（在项目根目录）：
    python scripts/seed_db.py

设计意图：数据要足够真实，让 Text-to-SQL 的问题有意思。所以刻意加入了：
  - 四张表需要 JOIN 才能回答大部分问题
  - 时间跨度 20 个月，可以问趋势、同比、环比
  - 部分字段留有 NULL（客户地区、订单渠道），用来测试 agent 对空值的处理
  - 订单有取消和退款状态，统计销售额时必须排除，这是最容易出错的地方
"""

import random
import sqlite3
from datetime import date, timedelta
from pathlib import Path

# 固定随机种子，保证每次生成的数据一样，评测结果才可复现
random.seed(42)

DB_PATH = Path(__file__).resolve().parent.parent / "data" / "shop.db"

START_DATE = date(2025, 1, 1)
END_DATE = date(2026, 8, 31)

REGIONS = ["华东", "华北", "华南", "西南", "东北", None]  # None 用来制造空值
LEVELS = ["普通", "银卡", "金卡", "钻石"]
CHANNELS = ["APP", "小程序", "网页", None]
ORDER_STATUS = ["已完成", "已完成", "已完成", "已完成", "已取消", "已退款"]

CATEGORIES = {
    "手机数码": ["无线耳机", "智能手表", "蓝牙音箱", "充电宝", "手机壳", "自拍杆"],
    "电脑办公": ["机械键盘", "无线鼠标", "显示器", "笔记本支架", "USB集线器", "移动硬盘"],
    "家用电器": ["空气净化器", "电饭煲", "扫地机器人", "加湿器", "电风扇", "微波炉"],
    "服饰鞋包": ["运动鞋", "双肩包", "羽绒服", "牛仔裤", "卫衣", "帽子"],
    "食品生鲜": ["坚果礼盒", "进口牛排", "有机蔬菜", "咖啡豆", "蜂蜜", "橄榄油"],
}

# 字段中文注释。SQLite 原生不支持列注释，所以单独用一张表存，
# 后端 /api/schema 接口和喂给模型的表结构描述都会用到它。
COMMENTS = {
    "customers": {
        "_table": "客户表",
        "id": "客户ID",
        "name": "客户姓名",
        "region": "所在地区，可能为空",
        "level": "会员等级：普通/银卡/金卡/钻石",
        "registered_at": "注册日期，格式 YYYY-MM-DD",
    },
    "products": {
        "_table": "商品表",
        "id": "商品ID",
        "name": "商品名称",
        "category": "商品分类",
        "price": "标准售价，单位元",
        "cost": "成本价，单位元。毛利 = 售价 - 成本",
    },
    "orders": {
        "_table": "订单表。注意：统计销售额时必须排除已取消和已退款的订单",
        "id": "订单ID",
        "customer_id": "下单客户ID，关联 customers.id",
        "created_at": "下单日期，格式 YYYY-MM-DD",
        "status": "订单状态：已完成/已取消/已退款",
        "channel": "下单渠道：APP/小程序/网页，可能为空",
    },
    "order_items": {
        "_table": "订单明细表，一个订单包含一到多个商品",
        "id": "明细ID",
        "order_id": "订单ID，关联 orders.id",
        "product_id": "商品ID，关联 products.id",
        "quantity": "购买数量",
        "unit_price": "成交单价，可能因促销低于商品标准售价",
        "amount": "该行小计金额 = 数量 × 成交单价",
    },
}

SCHEMA_SQL = """
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS customers;
DROP TABLE IF EXISTS _column_comments;

CREATE TABLE customers (
    id            INTEGER PRIMARY KEY,
    name          TEXT    NOT NULL,
    region        TEXT,
    level         TEXT    NOT NULL,
    registered_at TEXT    NOT NULL
);

CREATE TABLE products (
    id       INTEGER PRIMARY KEY,
    name     TEXT    NOT NULL,
    category TEXT    NOT NULL,
    price    REAL    NOT NULL,
    cost     REAL    NOT NULL
);

CREATE TABLE orders (
    id          INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    created_at  TEXT    NOT NULL,
    status      TEXT    NOT NULL,
    channel     TEXT
);

CREATE TABLE order_items (
    id         INTEGER PRIMARY KEY,
    order_id   INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity   INTEGER NOT NULL,
    unit_price REAL    NOT NULL,
    amount     REAL    NOT NULL
);

CREATE TABLE _column_comments (
    table_name  TEXT NOT NULL,
    column_name TEXT NOT NULL,
    comment     TEXT NOT NULL
);

CREATE INDEX idx_orders_created ON orders(created_at);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_items_product ON order_items(product_id);
"""

SURNAMES = "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
GIVEN = "伟芳娜秀敏静丽强磊洋勇军杰涛明超霞平刚桂英华文玲桦鑫悦晨"


def random_date(start: date, end: date) -> date:
    return start + timedelta(days=random.randint(0, (end - start).days))


def gen_customers(count=500):
    rows = []
    for i in range(1, count + 1):
        name = random.choice(SURNAMES) + "".join(random.sample(GIVEN, random.choice([1, 2])))
        rows.append(
            (
                i,
                name,
                random.choice(REGIONS),
                random.choices(LEVELS, weights=[50, 25, 18, 7])[0],
                random_date(date(2024, 1, 1), END_DATE).isoformat(),
            )
        )
    return rows


def gen_products():
    rows = []
    pid = 1
    for category, names in CATEGORIES.items():
        for name in names:
            price = round(random.uniform(29, 3999), 2)
            rows.append((pid, name, category, price, round(price * random.uniform(0.45, 0.75), 2)))
            pid += 1
    return rows


def gen_orders(customer_count, count=12000):
    rows = []
    for i in range(1, count + 1):
        rows.append(
            (
                i,
                random.randint(1, customer_count),
                random_date(START_DATE, END_DATE).isoformat(),
                random.choice(ORDER_STATUS),
                random.choice(CHANNELS),
            )
        )
    return rows


def gen_order_items(order_count, products):
    rows = []
    item_id = 1
    for order_id in range(1, order_count + 1):
        for product in random.sample(products, random.choices([1, 2, 3, 4], weights=[45, 30, 18, 7])[0]):
            quantity = random.choices([1, 2, 3, 5], weights=[65, 22, 9, 4])[0]
            # 成交单价可能有折扣，制造「实际销售额不等于数量×标准售价」的真实情况
            unit_price = round(product[3] * random.choice([1.0, 1.0, 1.0, 0.95, 0.9, 0.8]), 2)
            rows.append((item_id, order_id, product[0], quantity, unit_price, round(quantity * unit_price, 2)))
            item_id += 1
    return rows


def main():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    print(f"正在生成数据库: {DB_PATH}")

    with sqlite3.connect(DB_PATH) as con:
        con.executescript(SCHEMA_SQL)

        customers = gen_customers()
        products = gen_products()
        orders = gen_orders(len(customers))
        items = gen_order_items(len(orders), products)

        con.executemany("INSERT INTO customers VALUES (?,?,?,?,?)", customers)
        con.executemany("INSERT INTO products VALUES (?,?,?,?,?)", products)
        con.executemany("INSERT INTO orders VALUES (?,?,?,?,?)", orders)
        con.executemany("INSERT INTO order_items VALUES (?,?,?,?,?,?)", items)

        comment_rows = [
            (table, column, text)
            for table, cols in COMMENTS.items()
            for column, text in cols.items()
        ]
        con.executemany("INSERT INTO _column_comments VALUES (?,?,?)", comment_rows)

        print("\n生成完成，各表行数：")
        for table in ("customers", "products", "orders", "order_items"):
            count = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"  {table:<12} {count:>7} 行")

        revenue = con.execute(
            """
            SELECT ROUND(SUM(oi.amount), 2)
            FROM order_items oi
            JOIN orders o ON o.id = oi.order_id
            WHERE o.status = '已完成'
            """
        ).fetchone()[0]
        print(f"\n有效销售额合计（已排除取消和退款）: {revenue:,.2f} 元")
        print("这个数字可以当作你第一道评测题的标准答案。")


if __name__ == "__main__":
    main()

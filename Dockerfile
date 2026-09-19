# ============ Stage 1：生成示例数据库 ============
# seed_db.py 只用 Python 标准库；固定随机种子 42，每次生成逐字节一致的数据，
# 锚点数字（有效销售额 41,015,358.75）在容器里同样可复现
FROM python:3.12-slim AS seed
WORKDIR /seed
COPY scripts/seed_db.py scripts/seed_db.py
RUN python scripts/seed_db.py && test -f data/shop.db

# ============ Stage 2：安装依赖 + 生产构建 ============
FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.3.4 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ============ Stage 3：运行时（standalone + 静态资源 + 数据 + cassette） ============
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
# Next 16 standalone：server.js + 裁剪后的 node_modules；public 与 .next/static 官方要求手动拷入
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# 无 key 演示的 cassette（fixtures 不在 standalone trace 内，显式拷入）
COPY --from=build --chown=node:node /app/fixtures ./fixtures
# 示例数据库（seed 阶段生成，app.db 由应用运行时创建在同一目录）
COPY --from=seed --chown=node:node /seed/data/shop.db ./data/shop.db
USER node
EXPOSE 3000
CMD ["node", "server.js"]

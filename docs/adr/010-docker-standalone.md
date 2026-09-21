# ADR-010 · 部署用 Docker 单容器，不用 Vercel

**背景**：Next.js 默认部署目标是 Vercel。

**决策**：`output: 'standalone'` + 多阶段 Dockerfile（python seed → node 构建 → 最小 runner），单容器自托管。

**关键问题**：serverless 文件系统只读且实例间不共享——`app.db`（trace/报表）写不进去；函数时长上限与长流式 run 冲突。

**代价**：自己管服务器和 HTTPS；冷启动扩容手动。

**运营注记**：国内网络冷启动实测三档——npm 官方源 1070s / NPM_REGISTRY=npmmirror 开关 577s / 有缓存 281s。`NPM_REGISTRY` 构建参数是为国内面试官留的加速开关（容器网络不走宿主代理，是独立教训）。

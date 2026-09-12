# 项目约定

这个文件会在每次对话开始时自动加载，所以这里写的规矩对 AI 一直有效。

## 这是什么项目

**Caliber** —— 一个会对错口径说「不」的中文取数 agent。用户用自然语言问数，它生成并只读执行 SQL，并在数字交付之前，用代码强制的口径规则和结果体检拦下「SQL 跑通了、图也画了、但数字是错的」那一整类错误。

技术栈是**纯 Next.js 15 全栈**（App Router + Route Handler 手写 SSE + Server Actions），单容器、双 SQLite。**没有 Python 后端，没有 FastAPI** —— 早期文档里的 FastAPI 方案已作废。

这是一个**学习项目**，作者的目标是掌握 agent 开发和全栈开发能力，并把它作为求职作品。因此**代码是否由作者本人理解，比代码写得多快更重要。**

## 开工前必读

改任何代码之前，先读 `docs/`：

| 文档 | 内容 |
|---|---|
| `00-product.md` | 产品定位、差异化、凭什么不是 demo |
| `01-requirements.md` | 能力清单（P0/P1/P2）、验收标准、**明确不做的清单** |
| `02-architecture.md` | 架构、分层、数据流、目录结构 |
| `03-api-contract.md` | **唯一契约**，改接口必须先改这里和 `src/lib/events.ts` |
| `04-data-model.md` | 两个 SQLite 库的表设计 |
| `05-agent-design.md` | agent 循环、重试策略、上下文工程、可观测性 |
| `06-evaluation.md` | 评测体系 |
| `07-security.md` | 安全九层 + 攻击清单 |
| `08-roadmap.md` | **当前进度和每个任务的完成标准** |
| `09-decisions.md` | 技术决策记录（ADR） |
| `10-engineering.md` | 编码规范、环境变量、本机环境坑 |

## 最重要的一条规矩

**以下两个文件必须由作者本人手写，AI 不要代写：**

- `src/lib/agent/loop.ts` —— agent 主循环
- `src/lib/sql/guard.ts` —— SQL 安全检查

原因：这两处是面试必问的内容（「你的 agent 循环怎么设计的？重试几次？怎么防死循环？」「怎么防止 agent 删库？」）。如果是 AI 写的，作者答不上来，整个项目的价值就没了。

AI 在这两个文件上可以做的事：**审查、指出漏洞、解释某个写法的含义、提出改进建议**。不能做的事：直接给出完整实现。

如果作者明确要求「这次你直接写」，可以写，但要在回复里提醒他这块需要自己重写一遍。

## 其余部分可以放心让 AI 写

样板代码、类型定义、CSS 样式、ECharts 配置、测试用例、Docker 配置、README —— 这些交给 AI 效率更高，也不影响面试表现。

## 编码规范

完整版见 `docs/10-engineering.md`，这里是高频几条：

- **TypeScript 严格模式，禁止 `any`**；跨边界数据（HTTP body、LLM 输出、SSE 事件、环境变量）一律用 Zod 定义
- **文件读写必须显式写编码**：这台机器系统默认编码是 GBK（代码页 936），不写会出乱码
- **项目文件不要用 PowerShell 重定向生成**（`>` / `Out-File` / `Set-Content` 编码行为不一致），用编辑器或 Node 写
- 路径不写死，不要出现中文和空格
- 密钥只从环境变量读
- 组件放 `src/components/`，一个组件一个文件；业务逻辑放 `src/lib/`
- `src/app/` 下只放路由和薄编排，业务逻辑不写在 `page.tsx` / `route.ts` 里
- 一次提交只做一件事，提交信息用中文

## 三条不能破的底线

1. **agent 代码路径上绝不出现 `db.exec()`** —— 实测 `prepare()` 对多语句静默只执行第一句且不报错，`exec()` 是唯一真实多语句入口。有一条扫源码的断言测试守着
2. **不引入向量检索** —— 它会让同一道评测题两次跑出不同上下文，摧毁评测可复现性
3. **不引入任何 agent 框架** —— 一行 import 换掉整个项目的核心价值

## 常用命令

```bash
pnpm dev                # 开发服务器
pnpm test               # Vitest
pnpm eval               # 全量 30 题评测
pnpm eval:quick         # 10 题子集，90 秒
pnpm build              # 生产构建
docker compose up       # 完整容器验证
```

生成示例数据库（项目根目录）：

```bash
D:\anaconda\anaconda3.12\python.exe scripts\seed_db.py
```

## 这台机器的环境注意事项

- 系统 ANSI 代码页是 GBK（936），编码问题高发
- 已设用户级 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`
- Python 解释器在 `D:\anaconda\anaconda3.12\python.exe`
- 项目故意放在 `D:\code\` 而不是用户目录下，因为用户名含中文会引发路径编码问题
- React StrictMode 在 dev 下会让 SSE 开两条连接、LLM 付两次费，需要 `AbortController` + ref 哨兵

## 和作者协作的方式

- **一次改动控制在一个文件、一个功能**，方便作者 review
- 改完用一两句话说明改了什么、为什么，不要只说「已完成」
- 如果作者的要求和 `docs/` 冲突，**先提出来问**，不要默默按新要求做
- 作者是新手，遇到他可能不懂的概念主动解释一句，但不要长篇大论
- 作者让你干活时会引用具体文档（「按 `docs/03-api-contract.md` 实现桩接口」）—— 请严格照着那份文档做

# AI-Werewolf

**AI 狼人杀。**

## 技术栈

| 分层       | 选型                                                                        |
| ---------- | --------------------------------------------------------------------------- |
| 包管理     | pnpm 11 workspace                                                           |
| 语言       | TypeScript 6 + `verbatimModuleSyntax` + `NodeNext`                          |
| 运行时     | Node.js 24 LTS                                                              |
| 后端       | NestJS 11 + Prisma 7 + PostgreSQL 16                                        |
| Agent 编排 | LangChain / LangGraph                                                       |
| LLM        | 火山方舟(OpenAI 兼容协议,`@langchain/openai` + baseURL 指向 `ARK_BASE_URL`) |
| 队列       | BullMQ + Redis 7                                                            |
| 前端       | Vite 8 + React 19 + Tailwind 4 + shadcn/ui                                  |
| DTO/校验   | zod + `nestjs-zod`                                                          |
| Lint       | oxlint                                                                      |
| 测试       | Vitest                                                                      |

## 目录结构

```
apps/
  api/           NestJS API + Prisma schema + LangGraph 编排(核心)
  web/           React 前端
packages/
  shared/        枚举/常量单一真源(ROLES / FACTIONS / MEMORY_TYPES 等)
  tsconfig/      共享 tsconfig
  oxlint-config/ 共享 lint 规则
docs/            文档相关
```

## 如何跑起来

**前置**:Node.js ≥ 24、pnpm ≥ 11、Docker。

```bash
# 1. 装依赖
pnpm install

# 2. 复制环境变量模板(至少填 ARK_API_KEY,其他可用默认)
cp .env.example .env

# 3. 启动 postgres + redis
pnpm docker:up

# 4. 应用数据库迁移 + seed
pnpm --filter @ai-werewolf/api prisma:migrate
pnpm --filter @ai-werewolf/api prisma:seed

# 5. 启 API(会自动确保 docker 服务已起)
pnpm dev:api
```

启动后:

- API: http://localhost:3001
- Swagger UI: http://localhost:3001/api/docs

**常用命令**:

```bash
pnpm lint                                        # 全仓 oxlint
pnpm typecheck                                   # 全仓 tsc --noEmit
pnpm docker:down                                 # 停 postgres/redis
pnpm --filter @ai-werewolf/api prisma:studio     # 可视化数据库
```

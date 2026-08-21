# AI Werewolf - 多 Agent 狼人杀系统

这是一个基于 LLM 的多 Agent 狼人杀游戏系统，每个玩家由独立的 AI Agent 控制，通过自然语言进行推理、发言、投票。系统提供实时 SSE 观战、LangFuse 调用链追踪、完整的游戏统计分析。

---

## 技术栈

### 后端 (NestJS)

- **框架**: NestJS 11 + TypeScript 6
- **LLM 集成**: LangChain (OpenAI SDK) + 火山方舟 API
- **可观测性**: LangFuse (自托管) + Pino 结构化日志
- **游戏引擎**: 状态机 + BullMQ 异步队列
- **数据库**: PostgreSQL 16 (pgvector) + Prisma 7
- **缓存**: Redis 7 + ioredis
- **代码规范**: oxlint + pnpm workspace

### 前端 (React)

- **框架**: React 19 + TypeScript 6
- **构建工具**: Vite
- **UI 库**: shadcn/ui (Radix UI + Tailwind CSS)
- **实时通信**: EventSource (SSE)

---

## 架构设计

### 游戏引擎（状态机）

```
┌─────────────────┐
│   Init Node     │  初始化对局
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Night Phase   │  夜晚行动（狼人刀人、预言家查验、女巫用药）
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Day Phase     │  白天发言 → 投票 → 放逐
└────────┬────────┘
         │
         ▼
    [判断胜负]
         │
      Yes │ No
         ▼  │
    [结束] └──┐
              │
              └─→ 回到 Night Phase
```

### Agent 决策流程（两阶段）

```
┌──────────────────────────────────────────┐
│  1. Prepare Context                       │
│  - 查询 Player + Game                     │
│  - 查询 Event 历史（按权限过滤）          │
│  - 查询 Memory（persona, strategy）       │
│  - 构建分层上下文（关键信息/最近/历史）  │
│  - 组装 System Prompt（渐进式披露）      │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  2. Stream Reasoning (阶段1)              │
│  - 流式输出推理过程（自然语言）           │
│  - LangFuse 追踪                          │
│  - 保存到跨轮记忆                         │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  3. Generate Decision (阶段2)             │
│  - 根据推理结果生成结构化决策             │
│  - Zod Schema 校验 + 自动重试             │
│  - LangFuse 追踪                          │
└──────────────────────────────────────────┘
```

### SSE 观战架构

```
┌─────────────┐    SSE     ┌─────────────┐
│   Browser   │◄───────────┤  NestJS API │
└─────────────┘            └──────┬──────┘
                                  │
                                  │ Redis Pub/Sub
                                  │
                           ┌──────▼──────┐
                           │  BullMQ     │
                           │  Worker     │
                           └─────────────┘
```

事件类型：

- `connection.ready` - 连接建立 + 快照推送
- `scene.open` - 场景开启（发言、投票、裁判播报等）
- `scene.append` - 场景内容流式追加（thinking / content）
- `scene.close` - 场景结束
- `game.finished` - 对局结束
- `player.died` - 玩家死亡

---

## 快速开始

### 1. 环境准备

**必需**：

- Node.js 24+
- pnpm 11+
- Docker & Docker Compose

### 2. 启动基础设施

```bash
# 启动 PostgreSQL + Redis（必需）
pnpm docker:up

# 启动 LangFuse 追踪面板（可选，不启动则追踪静默降级）
pnpm docker:langfuse
```

等待所有服务健康检查通过。如果启动了 LangFuse，访问 http://localhost:3100 初始化：

1. 创建账号
2. 创建项目（如 `ai-werewolf`）
3. 获取 `Public Key` 和 `Secret Key`

### 3. 配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑 .env，填写必需配置：
# - ARK_API_KEY: 火山方舟 API Key
#
# LangFuse 追踪（可选）：
# - LANGFUSE_PUBLIC_KEY: 从 http://localhost:3100 获取
# - LANGFUSE_SECRET_KEY: 从 http://localhost:3100 获取
```

### 4. 安装依赖 & 初始化数据库

```bash
pnpm install
cd apps/api
pnpm prisma:migrate     # 执行数据库迁移
pnpm prisma:seed        # 初始化种子数据（预设、Agent）
```

### 5. 启动应用

```bash
# 根目录并行启动前后端
pnpm dev

# 或单独启动
pnpm dev:api    # 后端: http://localhost:3001
pnpm dev:web    # 前端: http://localhost:3000
```

### 6. 创建对局并观战

1. 访问 http://localhost:3000
2. 点击「创建对局」，选择预设（如 6 人标准局）
3. 点击「观战」，实时查看 AI Agent 推理和发言
4. 访问 http://localhost:3100 查看 LangFuse 调用链（需已启动）

---

## API 文档

启动后访问 http://localhost:3001/api/docs 查看 Swagger 文档。

### 核心接口

- `POST /api/games` - 创建对局
- `GET /api/games/:id` - 获取对局详情
- `GET /api/games/:id/stream` - SSE 观战流

---

## LangFuse 追踪

LangFuse 记录每个 Agent 的完整推理链：

追踪按 `gameId → session`、`playerId → user` 映射，因此面板上可以「按一局」聚合整条调用链，也可以「按一个玩家」筛出他全场的推理。

实际上报的 run 名称（即面板上的调用节点）：

| run 名称          | 触发时机                  | 说明                   |
| ----------------- | ------------------------- | ---------------------- |
| `reasoning`       | 夜间行动 / 投票等决策场景 | 流式推理正文           |
| `speech-thinking` | 发言类场景阶段 1          | 思考过程               |
| `speech-content`  | 发言类场景阶段 2          | 发言正文               |
| `decision`        | 结构化决策                | jsonMode 输出          |
| `decision-retry`  | Zod 校验失败后            | 带错误上下文的单次重试 |

每次调用附带的 metadata：`gameId`、`playerId`、`modelName`、`scenario`、`seatNo`、`role`；
tags 为 `[run 名称, modelName, scenario]`。
---

## 项目结构

```
.
├── apps/
│   ├── api/                    # NestJS 后端
│   │   ├── src/
│   │   │   ├── agent-runtime/  # Agent 运行时（两阶段决策）
│   │   │   ├── game-engine/    # 状态机游戏引擎
│   │   │   ├── game-queue/     # BullMQ 异步队列
│   │   │   ├── observability/  # LangFuse + Pino
│   │   │   ├── stats/          # 统计分析
│   │   │   ├── sse/            # SSE 观战
│   │   │   └── ...
│   │   └── prisma/
│   │       └── schema.prisma   # 数据库 Schema
│   └── web/                    # React 前端
│       └── src/
│           ├── pages/          # 页面
│           ├── components/     # 组件
│           └── hooks/          # 自定义 Hook
├── packages/
│   └── shared/                 # 共享类型和常量
├── docker-compose.yml          # 基础设施
├── pnpm-workspace.yaml         # pnpm workspace
└── README.md
```

---

## 开发指南

### 代码规范

```bash
pnpm check          # lint + typecheck
pnpm format         # Prettier 格式化
```

### 数据库操作

```bash
cd apps/api
pnpm prisma:migrate       # 创建迁移
pnpm prisma:studio        # 可视化数据库
pnpm prisma:reset         # 重置数据库（慎用）
```

## License

MIT

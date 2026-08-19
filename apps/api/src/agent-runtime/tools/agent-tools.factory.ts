import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';

/**
 * Agent 工具工厂
 *
 * @deprecated 两阶段决策模式已移除工具调用，改用 Structured Output。
 * 保留此类仅为保持架构完整性，所有工具构建方法已删除。
 *
 * 历史架构：
 * - 负责根据场景和上下文创建 LangChain 工具
 * - 统一注入 ToolContext（gameId, currentPlayerId）
 * - 夜间工具通过角色工具注册表动态获取（支持角色插拔）
 *
 * 当前架构：
 * - 所有决策通过两阶段模式完成（streamReasoning + generateDecision）
 * - Node 层使用 JSON Schema 定义结构化输出
 */
@Injectable()
export class AgentToolsFactory {
  constructor(private readonly prisma: PrismaService) {}
}

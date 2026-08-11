import { Injectable } from '@nestjs/common';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { PrismaService } from '@/prisma/prisma.service';
import { createCastVoteTool } from './cast-vote.tool';
import { createMakeSpeechTool } from './make-speech.tool';
import { createSkipActionTool } from './skip-action.tool';
import type { ToolContext } from './tool-context';
import { roleToolsRegistry } from './role-tools.registry';

/**
 * Agent 工具工厂
 *
 * 负责根据场景和上下文创建工具
 * - 统一注入 ToolContext（gameId, currentPlayerId）
 * - 存活玩家列表由 Agent Runtime 在 System Prompt 中注入，无需工具查询
 * - 夜间工具通过角色工具注册表动态获取（支持角色插拔）
 */
@Injectable()
export class AgentToolsFactory {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建投票场景的工具
   */
  buildVotingTools(ctx: ToolContext): StructuredToolInterface[] {
    return [createCastVoteTool(ctx)];
  }

  /**
   * 创建发言场景的工具
   */
  buildSpeechTools(ctx: ToolContext): StructuredToolInterface[] {
    return [createMakeSpeechTool(ctx)];
  }

  /**
   * 创建夜间行动场景的工具（根据角色动态生成）
   *
   * @param ctx - 工具上下文
   * @param role - 玩家角色
   */
  buildNightActionTools(ctx: ToolContext, role: string): StructuredToolInterface[] {
    const tools: StructuredToolInterface[] = [];

    // 所有角色都可以空过
    tools.push(createSkipActionTool(ctx));

    // 从注册表获取角色特定工具
    const roleTools = roleToolsRegistry.getTools(role, ctx);
    tools.push(...roleTools);

    return tools;
  }
}

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { assembleVotingSystemPrompt } from '../prompts/prompt-assembler';
import { AgentToolsFactory } from './tools/tools.factory';
import type { ToolContext } from './tools/tool-context';
import type { Env } from '../config/env.validation';
import type { CastVoteOutput } from './tools/cast-vote.tool';

export type VotingAgentInput = {
  ctx: ToolContext; // 身份上下文
  scenarioPrompt: string; // 当前局面提示词，由调用方给出
  maxIterations: number; // ReAct 循环上限（业务参数，不同 Agent 类型不同）
};

export type VotingAgentOutput =
  | { type: 'vote'; vote: CastVoteOutput; systemPrompt: string }
  | { type: 'abstain'; reason: string; systemPrompt: string };

@Injectable()
export class AgentRuntimeService {
  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
  ) {}

  /**
   * 投票决策
   *
   * TODO：
   * 1. 检测连续空轮（无 tool_calls 且 content 为空）提前熔断，避免"空转"
   * 2. cast_vote 被调用时，先执行所有工具、喂结果给模型，再让它确认（避免"同轮既查询又投票"的边缘情况）
   * 3. 添加"同一工具连续失败 N 次"的熔断计数（避免参数错误导致的死循环）
   *
   * @param input - Agent 输入
   * @returns vote 投票对象或弃权
   */
  async runVotingAgent(input: VotingAgentInput): Promise<VotingAgentOutput> {
    // 拉取当前 Player 的角色 + memoryLabelSnapshot,装配 system prompt
    const player = await this.prisma.player.findUnique({
      where: { id: input.ctx.currentPlayerId },
      select: { agentId: true, role: true, memoryLabelSnapshot: true, gameId: true },
    });
    if (!player || player.gameId !== input.ctx.gameId) {
      throw new Error('玩家不存在或不属于该对局');
    }

    const memories = await this.memoryService.retrieveActiveMemories(
      player.agentId,
      player.memoryLabelSnapshot,
    );
    const systemPrompt = assembleVotingSystemPrompt({
      role: player.role as Parameters<typeof assembleVotingSystemPrompt>[0]['role'],
      memories,
    });

    const tools = this.toolsFactory.buildVotingTools(input.ctx);
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: this.configService.get('ARK_DEFAULT_MODEL'),
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
    }).bindTools(tools);

    const { maxIterations } = input;
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(input.scenarioPrompt),
    ];

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await model.invoke(messages);
      messages.push(response);

      // 检查是否有工具调用
      const toolCalls = response.tool_calls ?? [];
      if (toolCalls.length === 0) {
        // LLM 未调用工具，认为它在"思考"或给出解释，继续循环
        // 但如果是最后一轮，熔断为弃权
        if (iteration === maxIterations - 1) {
          return {
            type: 'abstain',
            reason: `超出 ${maxIterations} 轮迭代未产出投票决策`,
            systemPrompt,
          };
        }
        continue;
      }

      // 执行所有工具调用
      let finalVote: CastVoteOutput | null = null;
      for (const toolCall of toolCalls) {
        const tool = tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          throw new Error(`工具 ${toolCall.name} 未注册`);
        }

        try {
          const toolResult = await tool.invoke(toolCall.args ?? {});
          messages.push(
            new ToolMessage({
              content: JSON.stringify(toolResult),
              tool_call_id: toolCall.id!,
            }),
          );

          // 如果是 cast_vote，记录最终投票
          if (toolCall.name === 'cast_vote') {
            finalVote = toolResult as CastVoteOutput;
          }
        } catch (error) {
          // 工具执行失败，将错误信息返回给 LLM 让它重试
          const errorMsg = error instanceof Error ? error.message : String(error);
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: errorMsg }),
              tool_call_id: toolCall.id!,
            }),
          );
        }
      }

      // 如果本轮调用了 cast_vote 且成功，认为决策完成
      if (finalVote) {
        return { type: 'vote', vote: finalVote, systemPrompt };
      }
    }

    // 超出迭代上限仍未投票，弃权
    return {
      type: 'abstain',
      reason: `超出 ${maxIterations} 轮迭代未产出投票决策`,
      systemPrompt,
    };
  }
}

import { Injectable } from '@nestjs/common';
import { ROLES, ACTION_TYPES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { checkSeerResult } from '../../rules/seer-check';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 构建预言家查验决策 Schema（值域动态收敛到合法候选）
 */
function buildSeerCheckSchema(legalSeatNos: number[]) {
  return z.object({
    action: z.enum(['check_identity']),
    targetSeatNo: z
      .number()
      .int()
      .describe(`要查验的座位号（只能从合法候选中选择：${legalSeatNos.join('、')}号）`),
  });
}

type SeerCheckDecision = {
  action: 'check_identity';
  targetSeatNo: number;
};

/**
 * 预言家查验节点（两阶段版本）
 */
@Injectable()
export class SeerCheckNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  /**
   * 创建节点工厂函数
   */
  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const seer = state.players.find((p) => p.isAlive && p.role === ROLES.SEER);

      if (!seer) {
        return {};
      }

      const nightPromptEvent = await context.eventWriter.writeNightPromptEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: '预言家，请睁眼。',
        targetRole: 'SEER',
      });
      await context.eventBus?.publish(nightPromptEvent);

      // 查询本局预言家已查验过的座位号（用于硬校验「未查验过」）
      const checkedEvents = await context.prisma.event.findMany({
        where: { gameId: state.gameId, actionType: ACTION_TYPES.SEER_CHECK, actorId: seer.id },
        select: { content: true },
      });
      const checkedSeatNos = new Set(
        checkedEvents
          .map((e) => (e.content as { targetSeatNo?: number } | null)?.targetSeatNo)
          .filter((n): n is number => typeof n === 'number'),
      );

      // 计算合法查验候选：存活 + 非自己 + 未查验过
      const legalSeatNos = state.players
        .filter((p) => p.isAlive && p.id !== seer.id && !checkedSeatNos.has(p.seatNo))
        .map((p) => p.seatNo);

      if (legalSeatNos.length === 0) {
        return {};
      }

      try {
        const threadId = getPlayerThreadId(state.gameId, seer.id);

        // 准备上下文（Node 层收集数据 + 注入合法候选）
        const legalHint = `你今晚只能查验以下存活且未查验过的玩家：${legalSeatNos.join('号、')}号。`;
        const contextData = await this.prepareContext(state, seer.id, context, legalHint);

        // 阶段1：流式推理
        const reasoning = await this.agentRuntime.streamReasoning(
          contextData,
          threadId,
          undefined,
          (_token) => {
            // 可选：SSE 推送推理过程
          },
        );

        // 阶段2：生成结构化决策
        const decision = await this.agentRuntime.generateDecision<SeerCheckDecision>(
          contextData,
          reasoning,
          buildSeerCheckSchema(legalSeatNos),
          undefined,
          threadId,
        );

        // 执行决策
        if (decision.action === 'check_identity') {
          const targetPlayer = state.players.find((p) => p.seatNo === decision.targetSeatNo);

          // 硬校验：目标必须存活、非自己、未查验过
          if (
            !targetPlayer ||
            !targetPlayer.isAlive ||
            targetPlayer.seatNo === seer.seatNo ||
            checkedSeatNos.has(decision.targetSeatNo)
          ) {
            gameLogger.warn(
              `[预言家查验] 目标座位号 ${decision.targetSeatNo} 非法，降级为随机查验`,
            );
            return this.fallbackToRandom(state, seer, context, checkedSeatNos);
          }

          const checkResult = checkSeerResult(targetPlayer);

          const seerCheckEvent = await context.eventWriter.writeSeerCheckEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: seer.id,
            targetSeatNo: targetPlayer.seatNo,
            result: checkResult,
            thinking: reasoning,
          });
          await context.eventBus?.publish(seerCheckEvent);

          return {
            seerCheckTarget: decision.targetSeatNo,
            seerCheckResult: { targetSeatNo: decision.targetSeatNo, result: checkResult },
          };
        } else {
          gameLogger.warn('[预言家查验] 决策格式错误，降级为随机查验');
          return this.fallbackToRandom(state, seer, context, checkedSeatNos);
        }
      } catch (error) {
        gameLogger.error(
          `[预言家查验] 执行异常，降级为随机查验: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.fallbackToRandom(state, seer, context, checkedSeatNos);
      }
    };
  }

  /**
   * 准备上下文（Node 层负责数据收集）
   */
  private async prepareContext(
    state: GameGraphState,
    playerId: string,
    _context: any,
    additionalContext?: string,
  ): Promise<{
    systemPrompt: string;
    player: any;
    game: any;
  }> {
    // 复用 AgentRuntimeService 的 prepareContextPublic
    return this.agentRuntime.prepareContextPublic(
      state.gameId,
      playerId,
      'night_action' as any,
      additionalContext,
    );
  }

  /**
   * 降级策略：随机查验
   */
  private async fallbackToRandom(
    state: GameGraphState,
    seer: any,
    context: any,
    checkedSeatNos: Set<number>,
  ) {
    const candidates = state.players.filter(
      (p) => p.isAlive && p.id !== seer.id && !checkedSeatNos.has(p.seatNo),
    );

    if (candidates.length > 0) {
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      const checkResult = checkSeerResult(target);

      const event = await context.eventWriter.writeSeerCheckEvent({
        gameId: state.gameId,
        day: state.currentDay,
        actorId: seer.id,
        targetSeatNo: target.seatNo,
        result: checkResult === 'werewolf' ? 'werewolf' : 'good',
      });
      await context.eventBus?.publish(event);

      return {
        seerCheckTarget: target.seatNo,
        seerCheckResult: { targetSeatNo: target.seatNo, result: checkResult },
      };
    }

    return {};
  }
}

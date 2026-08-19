import { Injectable } from '@nestjs/common';
import { ROLES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 构建女巫毒药决策 Schema（值域动态收敛到存活玩家）
 */
function buildWitchPoisonSchema(legalSeatNos: number[]) {
  return z.object({
    action: z.enum(['poison', 'skip']),
    targetSeatNo: z
      .number()
      .int()
      .optional()
      .describe(`要毒的座位号（只能选：${legalSeatNos.join('、')}号；action=poison 时必填）`),
  });
}

type WitchPoisonDecision =
  | {
      action: 'poison';
      targetSeatNo: number;
    }
  | {
      action: 'skip';
    };

/**
 * 女巫毒药节点（两阶段版本）
 */
@Injectable()
export class WitchPoisonNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const witch = state.players.find((p) => p.isAlive && p.role === ROLES.WITCH);

      if (!witch) {
        return {};
      }

      if (witch.hasPoisonUsed) {
        return {};
      }

      if (state.witchAntidoteTarget) {
        return {};
      }

      const nightPromptEvent = await context.eventWriter.writeNightPromptEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: '女巫，你要使用毒药吗？',
        targetRole: 'WITCH',
      });
      await context.eventBus?.publish(nightPromptEvent);

      // 计算合法毒药目标：存活玩家（女巫不可自救，排除自己）
      const legalSeatNos = state.players
        .filter((p) => p.isAlive && p.id !== witch.id)
        .map((p) => p.seatNo);

      if (legalSeatNos.length === 0) {
        return {};
      }

      try {
        const contextData = await this.agentRuntime.prepareContextPublic(
          state.gameId,
          witch.id,
          'night_action' as any,
          `你今晚只能毒以下存活玩家之一：${legalSeatNos.join('号、')}号。`,
        );

        const threadId = getPlayerThreadId(state.gameId, witch.id);

        // 阶段1：流式推理
        const reasoning = await this.agentRuntime.streamReasoning(
          contextData,
          threadId,
          undefined,
          (_token) => {
            // 可选：SSE 推送推理过程
          },
        );

        // 阶段2：生成决策
        const decision = await this.agentRuntime.generateDecision<WitchPoisonDecision>(
          contextData,
          reasoning,
          buildWitchPoisonSchema(legalSeatNos),
          undefined,
          threadId,
        );

        if (decision.action === 'poison') {
          const targetPlayer = state.players.find((p) => p.seatNo === decision.targetSeatNo);
          if (!targetPlayer || !targetPlayer.isAlive || targetPlayer.id === witch.id) {
            gameLogger.warn(
              `[女巫毒药] 目标座位号 ${decision.targetSeatNo} 非法，降级为不使用毒药`,
            );
            return {};
          }

          const poisonEvent = await context.eventWriter.writeWitchPoisonEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: targetPlayer.id,
            targetSeatNo: targetPlayer.seatNo,
            thinking: reasoning,
          });
          await context.eventBus?.publish(poisonEvent);

          return {
            witchPoisonTarget: targetPlayer.id,
            players: state.players.map((p) =>
              p.id === witch.id ? { ...p, hasPoisonUsed: true, poisonUsedOn: targetPlayer.id } : p,
            ),
          };
        } else {
          const poisonEvent = await context.eventWriter.writeWitchPoisonEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: witch.id,
            targetSeatNo: 0,
            thinking: reasoning,
          });
          await context.eventBus?.publish(poisonEvent);

          return {};
        }
      } catch (error) {
        gameLogger.error(
          `[女巫毒药] Agent 执行异常，降级为不使用: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 降级策略：不使用毒药
      return {};
    };
  }
}

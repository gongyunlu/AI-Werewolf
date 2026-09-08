import { Injectable } from '@nestjs/common';
import { ROLES } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { isAbortError } from '@/agent-runtime/abort.utils';

/**
 * 构建女巫解药决策 Schema（值域收敛到刀口座位）
 */
function buildWitchAntidoteSchema(legalSeatNos: number[]) {
  return z.object({
    action: z.enum(['antidote', 'skip']),
    targetSeatNo: z
      .number()
      .int()
      .optional()
      .describe(`要救的座位号（只能选：${legalSeatNos.join('、')}号；action=antidote 时必填）`),
  });
}

type WitchAntidoteDecision =
  | {
      action: 'antidote';
      targetSeatNo: number;
    }
  | {
      action: 'skip';
    };

/**
 * 女巫解药节点（理由与动作一并生成）
 */
@Injectable()
export class WitchAntidoteNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const witch = state.players.find((p) => p.isAlive && p.role === ROLES.WITCH);

      if (!witch) {
        return {};
      }

      if (witch.hasAntidoteUsed) {
        return {};
      }

      if (!state.wolfTarget) {
        return {};
      }

      // 女巫不能自救：刀口是自己时无合法用药目标，直接不用药（刀口信息由 WOLF_KILL 事件可见）
      if (state.wolfTarget === witch.id) {
        return {};
      }

      const nightPromptEvent = await context.eventWriter.writeNightPromptEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: '女巫，请睁眼。',
        targetRole: 'WITCH',
      });
      await context.eventBus?.publish(nightPromptEvent);

      const targetPlayer = state.players.find((p) => p.id === state.wolfTarget);
      if (!targetPlayer) {
        throw new Error(`[女巫解药] 数据一致性错误：未找到狼刀目标 ${state.wolfTarget}`);
      }

      const wolfTargetInfo = `
## 今晚狼刀信息

今晚 **${targetPlayer.seatNo}号位** 被狼人刀中。
你只能选择救 ${targetPlayer.seatNo}号位，或不用药。
      `.trim();

      try {
        const contextData = await this.agentRuntime.prepareContextPublic(
          state.gameId,
          witch.id,
          'night_action' as any,
          wolfTargetInfo,
          'witch_save',
        );

        const threadId = getPlayerThreadId(state.gameId, witch.id);

        const { reasoning, decision } = await this.agentRuntime.decide<WitchAntidoteDecision>(
          contextData,
          buildWitchAntidoteSchema([targetPlayer.seatNo]),
          context.signal,
          threadId,
        );

        if (decision.action === 'antidote') {
          const target = state.players.find((p) => p.seatNo === decision.targetSeatNo);
          if (!target || target.id !== targetPlayer.id) {
            throw new Error(
              `[女巫解药] 数据一致性错误：未找到目标玩家 ${decision.targetSeatNo}号位`,
            );
          }

          const antidoteEvent = await context.eventWriter.writeWitchAntidoteEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: target.id,
            targetSeatNo: target.seatNo,
            thinking: reasoning,
          });
          await this.agentRuntime.recordExperienceUsages(contextData, antidoteEvent);
          await context.eventBus?.publish(antidoteEvent);

          return {
            witchAntidoteTarget: target.id,
            players: state.players.map((p) =>
              p.id === witch.id ? { ...p, hasAntidoteUsed: true, antidoteUsedOn: target.id } : p,
            ),
          };
        } else {
          const antidoteEvent = await context.eventWriter.writeWitchAntidoteEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: witch.id,
            targetSeatNo: 0,
            thinking: reasoning,
          });
          await this.agentRuntime.recordExperienceUsages(contextData, antidoteEvent);
          await context.eventBus?.publish(antidoteEvent);

          return {};
        }
      } catch (error) {
        if (isAbortError(error, context.signal)) {
          throw error;
        }
        gameLogger.error(
          `[女巫解药] Agent 执行异常，降级为自动使用: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 降级策略：自动使用解药

      const fallbackAntidoteEvent = await context.eventWriter.writeWitchAntidoteEvent({
        gameId: state.gameId,
        day: state.currentDay,
        actorId: witch.id,
        targetId: targetPlayer.id,
        targetSeatNo: targetPlayer.seatNo,
      });
      await context.eventBus?.publish(fallbackAntidoteEvent);

      return {
        witchAntidoteTarget: targetPlayer.id,
        players: state.players.map((p) =>
          p.id === witch.id ? { ...p, hasAntidoteUsed: true, antidoteUsedOn: targetPlayer.id } : p,
        ),
      };
    };
  }
}

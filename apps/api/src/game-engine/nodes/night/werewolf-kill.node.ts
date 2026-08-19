import { Injectable } from '@nestjs/common';
import { ROLES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import {
  singleWolfDecision,
  wolfDiscussion,
  wolfVoting,
  selectTargetFromVotes,
} from './werewolf-collaboration';

/**
 * 狼人刀人节点（两阶段版本）
 */
@Injectable()
export class WerewolfKillNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  /**
   * 创建节点工厂函数
   */
  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      const werewolves = state.players.filter((p) => p.isAlive && p.role === ROLES.WEREWOLF);

      if (werewolves.length === 0) {
        return {};
      }

      const nightPromptEvent = await context.eventWriter.writeNightPromptEvent({
        gameId: state.gameId,
        day: state.currentDay,
        content: '狼人，请睁眼。',
        targetRole: 'WEREWOLF',
      });
      await context.eventBus?.publish(nightPromptEvent);

      let targetPlayerId: string | null = null;
      try {
        if (werewolves.length === 1) {
          targetPlayerId = await singleWolfDecision(werewolves[0], state, context);
        } else {
          const discussion = await wolfDiscussion(werewolves, state, context);
          const votes = await wolfVoting(werewolves, state, context, discussion);
          targetPlayerId = selectTargetFromVotes(votes, state);
        }
      } catch (error) {
        gameLogger.error(
          `[狼人刀人] 协作流程异常，降级为随机落刀: ${error instanceof Error ? error.message : String(error)}`,
        );
        targetPlayerId = null;
      }

      // 降级策略：随机落刀
      if (!targetPlayerId) {
        gameLogger.warn('[狼人刀人] Agent 决策失败，降级为随机落刀');
        const nonWerewolves = state.players.filter((p) => p.isAlive && p.role !== ROLES.WEREWOLF);
        if (nonWerewolves.length > 0) {
          const randomTarget = nonWerewolves[Math.floor(Math.random() * nonWerewolves.length)];
          targetPlayerId = randomTarget.id;
        }
      }

      const target = targetPlayerId ? state.players.find((p) => p.id === targetPlayerId) : null;

      if (targetPlayerId && !target) {
        throw new Error(`[狼人刀人] 数据一致性错误：未找到目标玩家 ${targetPlayerId}`);
      }

      const wolfKillEvent = await context.eventWriter.writeWolfKillEvent({
        gameId: state.gameId,
        day: state.currentDay,
        targetId: targetPlayerId ?? undefined,
        targetSeatNo: target?.seatNo,
      });
      await context.eventBus?.publish(wolfKillEvent);

      return { wolfTarget: targetPlayerId ?? undefined };
    };
  }
}

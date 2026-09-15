import { failModelCall } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import { ROLES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { saveNodeValue } from '../node.types';
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
        phaseInstanceId: state.phaseInstanceId,
        signal: context.signal,
        gameId: state.gameId,
        day: state.currentDay,
        content: '狼人，请睁眼。',
        targetRole: 'WEREWOLF',
      });
      await context.eventBus?.publish(nightPromptEvent);

      let targetPlayerId: string | null = null;
      const proposalEventIds: string[] = [];
      try {
        if (werewolves.length === 1) {
          targetPlayerId = await singleWolfDecision(
            werewolves[0],
            state,
            context,
            proposalEventIds,
          );
        } else {
          await wolfDiscussion(werewolves, state, context);
          const votes = await wolfVoting(werewolves, state, context, proposalEventIds);
          targetPlayerId = await saveNodeValue(context, 'wolf-target', () =>
            selectTargetFromVotes(votes, state),
          );
        }
      } catch (error) {
        failModelCall(error, context, '[狼人刀人] 协作流程异常');
      }

      // 单狼决策与多人投票各自在内部处理「没有可用提案」的随机落刀，这里不再补一层。
      const target = targetPlayerId ? state.players.find((p) => p.id === targetPlayerId) : null;

      if (targetPlayerId && !target) {
        throw new Error(`[狼人刀人] 数据一致性错误：未找到目标玩家 ${targetPlayerId}`);
      }

      const wolfKillEvent = await context.eventWriter.writeWolfKillEvent({
        phaseInstanceId: state.phaseInstanceId,
        signal: context.signal,
        gameId: state.gameId,
        day: state.currentDay,
        targetId: targetPlayerId ?? undefined,
        targetSeatNo: target?.seatNo,
        proposalEventIds,
      });
      await context.eventBus?.publish(wolfKillEvent);

      return { wolfTarget: targetPlayerId ?? undefined };
    };
  }
}

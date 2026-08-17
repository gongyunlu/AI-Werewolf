import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { ROLES } from '@ai-werewolf/shared';
import {
  wolfDiscussion,
  wolfVoting,
  selectTargetFromVotes,
  singleWolfDecision,
} from './werewolf-collaboration';
import { gameLogger } from '../../utils/game-logger';

/**
 * 狼人刀人节点
 *
 * 职责：
 * 1. 检查是否有存活的狼人
 * 2. 多狼：内部讨论 → 投票决定
 * 3. 单狼：直接思考决策（预留 Thinking 展示）
 * 4. 统计投票，确定最终目标
 * 5. 更新 GameState.wolfTarget
 *
 * 规则：
 * - 如果只有 1 只狼，跳过讨论和投票，直接决策（保留 Thinking）
 * - 平票时随机选择
 * - 无有效投票时随机选择目标
 */
export const createWerewolfKillNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const werewolves = state.players.filter((p) => p.isAlive && p.role === ROLES.WEREWOLF);

    if (werewolves.length === 0) {
      gameLogger.debug('[狼人刀人] 无存活狼人，跳过');
      return {};
    }

    // 法官播报：狼人请睁眼

    // 使用多 Agent 协作流程
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

    // 降级策略：如果 Agent 决策失败，随机落刀
    if (!targetPlayerId) {
      gameLogger.warn('[狼人刀人] Agent 决策失败，降级为随机落刀');
      const nonWerewolves = state.players.filter((p) => p.isAlive && p.role !== ROLES.WEREWOLF);
      if (nonWerewolves.length > 0) {
        const randomTarget = nonWerewolves[Math.floor(Math.random() * nonWerewolves.length)];
        targetPlayerId = randomTarget.id;
        gameLogger.debug(`[狼人刀人] 随机选择 ${randomTarget.seatNo}号位 (${randomTarget.id})`);
      }
    }

    const target = targetPlayerId ? state.players.find((p) => p.id === targetPlayerId) : null;

    if (targetPlayerId && !target) {
      throw new Error(`[狼人刀人] 数据一致性错误：未找到目标玩家 ${targetPlayerId}`);
    }

    gameLogger.debug(
      `[狼人刀人] 最终决定${targetPlayerId ? `刀: ${target?.seatNo}号位 (${target?.role})` : '空刀'}`,
    );

    // 写入狼人刀人事件
    await context.eventWriter.writeWolfKillEvent({
      gameId: state.gameId,
      day: state.currentDay,
      targetId: targetPlayerId ?? undefined,
      targetSeatNo: target?.seatNo,
    });

    return { wolfTarget: targetPlayerId ?? undefined };
  };
};

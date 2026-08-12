import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * 女巫毒药节点
 *
 * 规则：
 * - 女巫必须存活
 * - 女巫必须还有毒药
 * - 同一回合不能同时使用解药和毒药
 * - 女巫可以选择不使用毒药
 */
export const createWitchPoisonNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const witch = state.players.find((p) => p.isAlive && p.role === ROLES.WITCH);

    if (!witch) {
      gameLogger.debug('[女巫毒药] 无存活女巫，跳过');
      return {};
    }

    if (witch.hasPoisonUsed) {
      gameLogger.debug('[女巫毒药] 毒药已使用，跳过');
      return {};
    }

    // 检查当前回合是否已使用解药
    if (state.witchAntidoteTarget) {
      gameLogger.debug('[女巫毒药] 当前回合已使用解药，不能使用毒药');
      return {};
    }

    // 尝试使用 Agent 决策
    try {
      const tools = context.toolsFactory.buildNightActionTools(
        { gameId: state.gameId, currentPlayerId: witch.id },
        'witch_poison',
      );

      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: witch.id,
        scenario: AGENT_SCENARIOS.NIGHT_ACTION,
        availableTools: tools,
        maxIterations: 5,
        threadId: getPlayerThreadId(state.gameId, witch.id),
      });

      if (result.success && result.result) {
        const toolResult = result.result as any;

        if (toolResult.action === 'poison') {
          const targetPlayer = state.players.find((p) => p.seatNo === toolResult.targetSeatNo);
          if (!targetPlayer) {
            throw new Error(
              `[女巫毒药] 数据一致性错误：未找到目标玩家 ${toolResult.targetSeatNo}号位`,
            );
          }

          gameLogger.debug(`[女巫毒药] 使用毒药毒: ${targetPlayer.seatNo}号位`);

          await context.eventWriter.writeWitchPoisonEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: targetPlayer.id,
            targetSeatNo: targetPlayer.seatNo,
            thinking: result.thinking,
          });

          return { witchPoisonTarget: targetPlayer.id };
        } else {
          gameLogger.debug('[女巫毒药] 选择不使用毒药');

          await context.eventWriter.writeWitchPoisonEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: witch.id,
            targetSeatNo: 0,
            thinking: result.thinking,
          });

          return {};
        }
      }

      gameLogger.debug('[女巫毒药] Agent 调用失败，不使用毒药');
      return {};
    } catch (error) {
      gameLogger.error(
        `[女巫毒药] Agent 执行异常，降级为不使用: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 降级决策：不使用毒药
    gameLogger.debug('[女巫毒药] 降级策略：不使用毒药');
    return {};
  };
};

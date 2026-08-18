import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * 女巫解药节点
 *
 * 规则：
 * - 女巫必须存活
 * - 女巫必须还有解药
 * - 女巫可以选择不使用解药
 */
export const createWitchAntidoteNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const witch = state.players.find((p) => p.isAlive && p.role === ROLES.WITCH);

    if (!witch) {
      gameLogger.debug('[女巫解药] 无存活女巫，跳过');
      return {};
    }

    if (witch.hasAntidoteUsed) {
      gameLogger.debug('[女巫解药] 解药已使用，跳过');
      return {};
    }

    // 空刀时无法使用解药，直接跳过
    if (!state.wolfTarget) {
      gameLogger.debug('[女巫解药] 今晚空刀，无法使用解药');
      return {};
    }

    await context.eventWriter.writeNightPromptEvent({
      gameId: state.gameId,
      day: state.currentDay,
      content: '女巫，请睁眼。',
      targetRole: 'WITCH',
    });

    // 构建狼刀目标信息
    const targetPlayer = state.players.find((p) => p.id === state.wolfTarget);
    if (!targetPlayer) {
      throw new Error(`[女巫解药] 数据一致性错误：未找到狼刀目标 ${state.wolfTarget}`);
    }

    const wolfTargetInfo = `
      ## 今晚狼刀信息\n
      今晚 **${targetPlayer.seatNo}号位** 被狼人刀中。\n
      你是否要使用解药救他/她？
    `.trim();

    // 尝试使用 Agent 决策
    try {
      const tools = context.toolsFactory.buildNightActionTools(
        { gameId: state.gameId, currentPlayerId: witch.id },
        'witch_antidote',
      );

      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: witch.id,
        scenario: AGENT_SCENARIOS.NIGHT_ACTION,
        availableTools: tools,
        maxIterations: 5,
        threadId: getPlayerThreadId(state.gameId, witch.id),
        additionalContext: wolfTargetInfo,
      });

      if (result.success && result.result) {
        const toolResult = result.result as any;

        if (toolResult.action === 'antidote') {
          const target = state.players.find((p) => p.seatNo === toolResult.targetSeatNo);
          if (!target) {
            throw new Error(
              `[女巫解药] 数据一致性错误：未找到目标玩家 ${toolResult.targetSeatNo}号位`,
            );
          }

          gameLogger.debug(`[女巫解药] 使用解药救: ${target.seatNo}号位`);

          await context.eventWriter.writeWitchAntidoteEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: witch.id,
            targetId: target.id,
            targetSeatNo: target.seatNo,
            thinking: result.thinking,
          });

          return { witchAntidoteTarget: target.id };
        } else {
          gameLogger.debug('[女巫解药] 选择不使用解药');

          await context.eventWriter.writeWitchAntidoteEvent({
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

      // Agent 调用失败，触发降级策略
      gameLogger.warn(
        `[女巫解药] Agent 执行失败，降级为自动使用${result.error ? `: ${result.error}` : ''}`,
      );
    } catch (error) {
      gameLogger.error(
        `[女巫解药] Agent 执行异常，降级为自动使用: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    gameLogger.debug(`[女巫解药] 降级决策，使用解药救: ${targetPlayer.seatNo}号位`);

    await context.eventWriter.writeWitchAntidoteEvent({
      gameId: state.gameId,
      day: state.currentDay,
      actorId: witch.id,
      targetId: targetPlayer.id,
      targetSeatNo: targetPlayer.seatNo,
    });

    return { witchAntidoteTarget: targetPlayer.id };
  };
};

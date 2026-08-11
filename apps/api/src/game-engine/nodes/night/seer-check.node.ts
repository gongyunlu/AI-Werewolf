import { Logger } from '@nestjs/common';
import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { checkSeerResult } from '../../rules/seer-check';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';

/**
 * 预言家查验节点
 */
export const createSeerCheckNode: NodeFactory = (context) => {
  const logger = new Logger('SeerCheckNode');

  return async (state: GameGraphState) => {
    const seer = state.players.find((p) => p.isAlive && p.role === ROLES.SEER);

    if (!seer) {
      logger.debug('[预言家查验] 无存活预言家，跳过');
      return {};
    }

    // 尝试使用 Agent 决策
    try {
      const tools = context.toolsFactory.buildNightActionTools(
        { gameId: state.gameId, currentPlayerId: seer.id },
        'seer',
      );

      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: seer.id,
        scenario: AGENT_SCENARIOS.NIGHT_ACTION,
        availableTools: tools,
        maxIterations: 5,
        threadId: getPlayerThreadId(state.gameId, seer.id),
      });

      if (result.success && result.result) {
        const toolResult = result.result as any;

        if (toolResult.action === 'check_identity') {
          const targetSeatNo = toolResult.targetSeatNo;
          const targetPlayer = state.players.find((p) => p.seatNo === targetSeatNo);

          if (!targetPlayer) {
            logger.warn(`[预言家查验] 目标座位号 ${targetSeatNo} 不存在，降级为随机查验`);
            // 跳到降级逻辑
          } else {
            const checkResult = checkSeerResult(targetPlayer);

            logger.log(`[预言家查验] 查验 ${targetSeatNo} 号位: ${checkResult}`);

            await context.eventWriter.writeSeerCheckEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: seer.id,
              targetSeatNo: targetPlayer.seatNo,
              result: checkResult === 'werewolf' ? 'werewolf' : 'good',
              thinking: result.thinking,
            });

            return {
              seerCheckTarget: targetSeatNo,
              seerCheckResult: { targetSeatNo, result: checkResult },
            };
          }
        } else {
          logger.warn('[预言家查验] Agent 未调用 check_identity，降级为随机查验');
        }
      } else {
        logger.warn('[预言家查验] Agent 执行失败，降级为随机查验');
      }
    } catch (error) {
      logger.error(
        `[预言家查验] Agent 执行异常，降级为随机查验: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 降级策略：随机查验
    const candidates = state.players.filter((p) => p.isAlive && p.id !== seer.id);

    if (candidates.length > 0) {
      const target = candidates[Math.floor(Math.random() * candidates.length)];
      const checkResult = checkSeerResult(target);

      logger.debug(`[预言家查验] 随机决策：查验 ${target.seatNo} 号位: ${checkResult}`);

      await context.eventWriter.writeSeerCheckEvent({
        gameId: state.gameId,
        day: state.currentDay,
        actorId: seer.id,
        targetSeatNo: target.seatNo,
        result: checkResult === 'werewolf' ? 'werewolf' : 'good',
      });

      return {
        seerCheckTarget: target.seatNo,
        seerCheckResult: { targetSeatNo: target.seatNo, result: checkResult },
      };
    }

    return {};
  };
};

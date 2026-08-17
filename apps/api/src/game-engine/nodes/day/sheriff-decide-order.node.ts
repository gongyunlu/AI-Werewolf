import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import type { GameGraphState } from '@/game-engine/core/types';
import type { NodeFactory } from '@/game-engine/nodes/node.types';
import {
  createDecideSpeechOrderTool,
  type DecideSpeechOrderOutput,
} from '@/agent-runtime/tools/decide-speech-order.tool';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import {
  calculateSpeechOrder,
  type SpeechOrderConfig,
} from '@/game-engine/utils/speech-order.utils';
import type { TypedRuleset } from '@/prisma/typed-models';
import { gameLogger } from '../../utils/game-logger';

/**
 * 警长决定发言顺序节点
 *
 * 规则：
 * - 只有警长存活时才执行
 * - 警长可以指定起始位置和方向
 * - 如果警长决策失败，使用默认规则
 */
export const createSheriffDecideOrderNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    const alivePlayers = state.players.filter((p) => p.isAlive);
    const sheriff = alivePlayers.find((p) => p.isSheriff);

    // 如果没有警长，直接跳过（使用后续的默认规则）
    if (!sheriff) {
      return {};
    }

    // 从 ruleset 读取配置
    const ruleset = (await context.prisma.ruleset.findUnique({
      where: { id: state.rulesetId },
    })) as TypedRuleset | null;

    if (!ruleset) {
      throw new Error(`[警长决定发言顺序] 数据一致性错误：未找到 ruleset ${state.rulesetId}`);
    }

    const config: SpeechOrderConfig = ruleset.definition.speechRules || {
      allowSheriffChooseOrder: true,
      sheriffSpeaksLast: true,
      alternateDaily: false,
    };

    // 如果不允许警长指定顺序，直接跳过
    if (!config.allowSheriffChooseOrder) {
      return {};
    }

    let sheriffChoice: { direction: 'left' | 'right' } | undefined;

    try {
      // 派发警长 Agent
      const tools = [
        createDecideSpeechOrderTool({ gameId: state.gameId, currentPlayerId: sheriff.id }),
      ];

      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: sheriff.id,
        scenario: AGENT_SCENARIOS.SHERIFF_DECIDE_ORDER,
        availableTools: tools,
        maxIterations: 3,
        threadId: getPlayerThreadId(state.gameId, sheriff.id),
      });

      if (result.success && result.result) {
        const toolResult = result.result as DecideSpeechOrderOutput;

        if (toolResult.action === 'decide_speech_order') {
          sheriffChoice = {
            direction: toolResult.direction,
          };

          await context.eventWriter.writeSheriffDecideOrderEvent({
            gameId: state.gameId,
            day: state.currentDay,
            sheriffId: sheriff.id,
            sheriffSeatNo: sheriff.seatNo!,
            direction: toolResult.direction,
          });
        }
      }
    } catch (error) {
      gameLogger.error(
        `[警长决定发言顺序] 出错: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 计算最终的发言顺序
    const orderResult = calculateSpeechOrder({
      state,
      config,
      currentTime: new Date(),
      sheriffChoice,
    });

    gameLogger.debug(
      `[警长决定发言顺序] 按 ${orderResult.direction === 'clockwise' ? '顺时针' : '逆时针'}顺序发言`,
    );

    // 写入状态
    return {
      speechOrder: orderResult.speechOrder,
      speechDirection: orderResult.direction,
      speechStartSeatNo: orderResult.startSeatNo,
      speechOrderReason: orderResult.reason,
    };
  };
};

import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import { gameLogger } from '../../utils/game-logger';

/**
 * 遗言节点工厂
 */
export function createLastWordsNode(context: NodeContext): GameNode {
  return async (state: GameGraphState): Promise<GameGraphUpdate> => {
    return lastWordsNode(state, context);
  };
}

/**
 * 遗言节点
 *
 * 首夜死亡的玩家发表遗言
 *
 * 规则：
 * - 只有首夜（第1夜）死亡的玩家才能发表遗言
 * - 第2夜及之后夜晚死亡的玩家无遗言
 * - 按座位号顺序发言
 * - 每人有一次遗言机会
 * - 遗言在正常发言阶段之前
 *
 * @param state 游戏状态
 * @param context 节点上下文
 * @returns 状态更新
 */
async function lastWordsNode(
  state: GameGraphState,
  context: NodeContext,
): Promise<GameGraphUpdate> {
  // 只在第1天执行遗言节点（首夜死亡才有遗言）
  if (state.currentDay !== 1) {
    return {};
  }

  // 查询首夜死亡的玩家（deathDay 为 1）
  const deadLastNight = await context.prisma.player.findMany({
    where: {
      gameId: state.gameId,
      deathDay: 1, // 只有首夜死亡才有遗言
    },
    orderBy: { seatNo: 'asc' },
  });

  if (deadLastNight.length === 0) {
    return {};
  }

  // 按座位号顺序发表遗言
  for (const player of deadLastNight) {
    gameLogger.debug(`[遗言阶段] ${player.seatNo}号位开始遗言`);

    // 调用 Agent 生成遗言
    try {
      // 构建遗言工具（复用 make_speech 工具）
      const tools = context.toolsFactory.buildSpeechTools({
        gameId: state.gameId,
        currentPlayerId: player.id,
      });

      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: player.id,
        scenario: AGENT_SCENARIOS.LAST_WORDS,
        availableTools: tools,
        maxIterations: 3,
        threadId: getPlayerThreadId(state.gameId, player.id),
      });

      if (result.success && result.result) {
        const toolResult = result.result as { action: string; content?: string };

        if (toolResult.action === 'make_speech' && toolResult.content) {
          gameLogger.debug(`[遗言阶段] ${player.seatNo}号位遗言: ${toolResult.content}`);

          // 写入遗言事件
          if (player.seatNo !== null) {
            await context.eventWriter.writePlayerSpeechEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              seatNo: player.seatNo,
              content: toolResult.content,
            });
          }
        } else {
          gameLogger.debug(`[遗言阶段] ${player.seatNo}号位选择不发表遗言`);
        }
      } else {
        gameLogger.warn(
          `[遗言阶段] ${player.seatNo}号位遗言 Agent 调用失败，跳过。原因: ${result.error || 'success=false 或 result 为空'}`,
        );
      }
    } catch (error) {
      gameLogger.error(
        `[遗言阶段] ${player.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {};
}

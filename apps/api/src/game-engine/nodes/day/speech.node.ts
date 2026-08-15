import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import {
  createMakeSpeechTool,
  type MakeSpeechOutput,
} from '@/agent-runtime/tools/make-speech.tool';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * 发言阶段节点
 *
 * 规则：
 * - 使用 state.speechOrder（由警长决定或自动计算）
 * - 降级：按座位号从小到大顺序发言
 * - 跳过已死亡玩家
 * - 玩家可以使用 skip_action 跳过发言
 */
export const createSpeechNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
    gameLogger.debug(`[发言阶段] Day ${state.currentDay} 开始发言`);

    // 法官播报：请按顺序发言
    context.broadcaster?.broadcastAnnouncement(
      state.gameId,
      'speech',
      state.currentDay,
      '请存活玩家按顺序发言。',
    );

    const alivePlayers = state.players.filter((p) => p.isAlive);

    // 使用预计算的发言顺序
    let orderedPlayers: typeof alivePlayers;
    if (state.speechOrder && state.speechOrder.length > 0) {
      // 按 speechOrder 排序
      orderedPlayers = state.speechOrder
        .map((seatNo) => alivePlayers.find((p) => p.seatNo === seatNo))
        .filter((p): p is NonNullable<typeof p> => p !== undefined);
    } else {
      // 降级：按座位号顺序
      orderedPlayers = alivePlayers.toSorted((a, b) => a.seatNo - b.seatNo);
    }

    // 按顺序派发 Agent
    for (const player of orderedPlayers) {
      try {
        // 检查是否有活跃 SSE 连接，如果没有则跳过该玩家
        if (!context.broadcaster?.hasActiveConnections(state.gameId)) {
          gameLogger.debug(
            `[发言阶段] 无活跃 SSE 连接，跳过 ${player.seatNo}号位（游戏将在下次恢复时重新执行）`,
          );
          throw new Error('No active SSE connections');
        }

        // 白天发言是关键环节，不允许跳过
        const tools = [createMakeSpeechTool({ gameId: state.gameId, currentPlayerId: player.id })];

        const result = await context.agentRuntime.run({
          gameId: state.gameId,
          playerId: player.id,
          scenario: AGENT_SCENARIOS.DAY_SPEECH,
          availableTools: tools,
          maxIterations: 3,
          threadId: getPlayerThreadId(state.gameId, player.id),
          onStreamToken: (token, contentType) => {
            context.broadcaster?.broadcastLLMToken(state.gameId, player.id, token, contentType);
          },
        });

        if (result.success && result.result) {
          const toolResult = result.result as MakeSpeechOutput;

          if (toolResult.action === 'make_speech') {
            gameLogger.debug(`[发言阶段] ${player.seatNo}号位发言: ${toolResult.content}`);

            // 写入 Event 表
            await context.eventWriter.writePlayerSpeechEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              seatNo: player.seatNo,
              content: toolResult.content,
              thinking: result.thinking,
            });
          } else {
            gameLogger.debug(`[发言阶段] ${player.seatNo}号位跳过发言`);
          }
        } else {
          gameLogger.warn(
            `[发言阶段] ${player.seatNo}号位 Agent 调用失败。原因: ${result.error || 'success=false 或 result 为空'}`,
          );
        }
      } catch (error) {
        gameLogger.error(
          `[发言阶段] ${player.seatNo}号位发言出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {};
  };
};

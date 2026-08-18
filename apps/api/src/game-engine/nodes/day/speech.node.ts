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
        // 白天发言是关键环节，不允许跳过
        const tools = [createMakeSpeechTool({ gameId: state.gameId, currentPlayerId: player.id })];

        const sceneId = `speech-${state.gameId}-${state.currentDay}-${player.id}`;
        const startedAt = Date.now();
        context.broadcaster?.emit(state.gameId, {
          type: 'scene.open',
          sceneId,
          sceneType: 'speech',
          visibility: 'public',
          actorId: player.id,
        });

        const result = await context.agentRuntime.run({
          gameId: state.gameId,
          playerId: player.id,
          scenario: AGENT_SCENARIOS.DAY_SPEECH,
          availableTools: tools,
          maxIterations: 3,
          threadId: getPlayerThreadId(state.gameId, player.id),
          onStreamToken: (token, contentType) => {
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.append',
              sceneId,
              token,
              contentType,
            });
          },
        });

        const speechContent =
          result.success && result.result
            ? ((result.result as MakeSpeechOutput).content ?? '')
            : '';

        // 将工具结果的 content 也流式推送（模拟打字机效果）
        if (speechContent) {
          // 按字符逐个推送
          for (const char of speechContent) {
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.append',
              sceneId,
              token: char,
              contentType: 'content',
            });
          }
        }

        context.broadcaster?.emit(state.gameId, {
          type: 'scene.close',
          sceneId,
          fullContent: result.thinking
            ? `[思考]\n${result.thinking}\n\n${speechContent}`
            : speechContent,
          durationMs: Date.now() - startedAt,
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

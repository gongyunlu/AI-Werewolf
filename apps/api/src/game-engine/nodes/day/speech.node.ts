import { Injectable } from '@nestjs/common';
import type { GameGraphState, PlayerState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 构建发言顺序上下文
 *
 * 白天发言顺序由 time_rule 决定（可能逆时针、随机起点），并非座位号顺序。
 * 显式注入顺序 + 该玩家的发言位置，避免模型臆测"前面有几位说过话"。
 */
function buildSpeechOrderContext(
  orderedPlayers: PlayerState[],
  player: PlayerState,
  index: number,
): string {
  const order = orderedPlayers.map((p) => `${p.seatNo}号位`).join(' → ');
  const before = orderedPlayers.slice(0, index).map((p) => `${p.seatNo}号位`);
  const after = orderedPlayers.slice(index + 1).map((p) => `${p.seatNo}号位`);

  return `
    ## 本轮发言顺序
    本轮发言顺序为：${order}
    你是第 ${index + 1} 位发言（共 ${orderedPlayers.length} 位）。
    ${before.length > 0 ? `在你之前已发言：${before.join('、')}` : '你是第一位发言，之前无人发言。'}
    ${after.length > 0 ? `在你之后将发言：${after.join('、')}` : '你是最后一位发言，之后无人发言。'}
  `.trim();
}

/**
 * 发言阶段节点（流式版本）
 */
@Injectable()
export class SpeechNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) =>
      async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
        const alivePlayers = state.players.filter((p) => p.isAlive);

        let orderedPlayers: typeof alivePlayers;
        if (state.speechOrder && state.speechOrder.length > 0) {
          orderedPlayers = state.speechOrder
            .map((seatNo) => alivePlayers.find((p) => p.seatNo === seatNo))
            .filter((p): p is NonNullable<typeof p> => p !== undefined);
        } else {
          orderedPlayers = alivePlayers.toSorted((a, b) => a.seatNo - b.seatNo);
        }

        for (const [index, player] of orderedPlayers.entries()) {
          try {
            const sceneId = `speech-${state.gameId}-${state.currentDay}-${player.id}`;
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.open',
              sceneId,
              sceneType: 'speech',
              visibility: 'public',
              actorId: player.id,
            });

            const contextData = await this.agentRuntime.prepareContextPublic(
              state.gameId,
              player.id,
              'day_speech' as any,
              buildSpeechOrderContext(orderedPlayers, player, index),
            );

            const threadId = getPlayerThreadId(state.gameId, player.id);

            // 流式输出：思考 + 发言正文
            const { thinking, content, thinkingDurationMs, contentDurationMs } =
              await this.agentRuntime.streamSpeech(contextData, threadId, {
                onThinking: (token) => {
                  context.broadcaster?.emit(state.gameId, {
                    type: 'scene.append',
                    sceneId,
                    token,
                    contentType: 'thinking',
                  });
                },
                onContent: (token) => {
                  context.broadcaster?.emit(state.gameId, {
                    type: 'scene.append',
                    sceneId,
                    token,
                    contentType: 'content',
                  });
                },
              });

            context.broadcaster?.emit(state.gameId, {
              type: 'scene.close',
              sceneId,
              thinkingDurationMs,
              contentDurationMs,
            });

            if (content) {
              await context.eventWriter.writePlayerSpeechEvent({
                gameId: state.gameId,
                day: state.currentDay,
                actorId: player.id,
                seatNo: player.seatNo,
                content,
                thinking,
              });
            }
          } catch (error) {
            gameLogger.error(
              `[发言阶段] ${player.seatNo}号位发言出错: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return {};
      };
  }
}

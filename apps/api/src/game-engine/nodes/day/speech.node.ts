import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

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

        for (const player of orderedPlayers) {
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
              undefined,
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

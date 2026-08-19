import { Injectable } from '@nestjs/common';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

/**
 * 遗言节点（流式版本）
 */
@Injectable()
export class LastWordsNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): (context: NodeContext) => GameNode {
    return (context) =>
      async (state: GameGraphState): Promise<GameGraphUpdate> => {
        if (state.currentDay !== 1) {
          return {};
        }

        const deadLastNight = await context.prisma.player.findMany({
          where: {
            gameId: state.gameId,
            deathDay: 1,
          },
          orderBy: { seatNo: 'asc' },
        });

        if (deadLastNight.length === 0) {
          return {};
        }

        for (const player of deadLastNight) {
          try {
            const contextData = await this.agentRuntime.prepareContextPublic(
              state.gameId,
              player.id,
              'last_words' as any,
              undefined,
            );

            const threadId = getPlayerThreadId(state.gameId, player.id);

            const sceneId = `last-words-${state.gameId}-${state.currentDay}-${player.id}`;
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.open',
              sceneId,
              sceneType: 'last_words',
              visibility: 'public',
              actorId: player.id,
            });

            // 流式输出：思考 + 遗言正文
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

            if (player.seatNo !== null) {
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
              `[遗言阶段] ${player.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return {};
      };
  }
}

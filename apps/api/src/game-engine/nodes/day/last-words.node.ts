import { failAfterEffect, allowModelFallback } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import { appendSceneNotice, type NodeContext, type GameNode } from '../node.types';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { throwIfAborted } from '@/llm/abort.utils';

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

        const deadLastNight = state.players
          .filter((p) => !p.isAlive && p.deathDay === 1)
          .toSorted((a, b) => a.seatNo - b.seatNo);

        if (deadLastNight.length === 0) {
          return {};
        }

        const completedSeats: number[] = [];
        const skippedSeats: number[] = [];
        for (const player of deadLastNight) {
          throwIfAborted(context.signal);
          const sceneId = `last-words-${state.gameId}-${state.currentDay}-${player.id}`;
          let sceneOpened = false;
          let thinkingDurationMs = 0;
          let contentDurationMs = 0;

          let effectStarted = false;
          try {
            const position = {
              day: state.currentDay,
              phase: '首夜死亡遗言',
              order: deadLastNight.map((p) => p.seatNo),
              completedSeats: [...completedSeats],
              skippedSeats: [...skippedSeats],
              round: 0,
              aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
            };
            const contextData = await this.agentRuntime.prepareContextPublic({
              gameId: state.gameId,
              playerId: player.id,
              scenario: 'last_words',
              actionType: 'speech',
              position,
            });

            context.broadcaster?.emit(state.gameId, {
              type: 'scene.open',
              sceneId,
              sceneType: 'last_words',
              visibility: 'public',
              actorId: player.id,
            });
            sceneOpened = true;

            // 流式输出：思考 + 遗言正文
            const result = await this.agentRuntime.streamSpeech(contextData, {
              signal: context.signal,
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

            const { thinking, content } = result;
            thinkingDurationMs = result.thinkingDurationMs;
            contentDurationMs = result.contentDurationMs;

            if (content) {
              effectStarted = true;
              const event = await context.eventWriter.writePlayerSpeechEvent({
                turn: { phase: position.phase, round: position.round },
                sceneId,
                sceneType: 'last_words',
                gameId: state.gameId,
                day: state.currentDay,
                actorId: player.id,
                seatNo: player.seatNo,
                content,
                thinking,
              });
              await this.agentRuntime.recordExperienceUsages(contextData, event);
              completedSeats.push(player.seatNo);
            } else {
              skippedSeats.push(player.seatNo);
            }
          } catch (error) {
            if (effectStarted) failAfterEffect(error);

            await allowModelFallback(error, context, player.id);
            appendSceneNotice(context, state.gameId, sceneId);
            skippedSeats.push(player.seatNo);
            gameLogger.error(
              `[遗言阶段] ${player.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
            );
          } finally {
            if (sceneOpened) {
              context.broadcaster?.emit(state.gameId, {
                type: 'scene.close',
                sceneId,
                thinkingDurationMs,
                contentDurationMs,
              });
            }
          }
        }
        return {};
      };
  }
}

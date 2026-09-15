import { failAfterEffect, failModelCall } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import { createSceneIdentity, type NodeFactory } from '../node.types';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { throwIfAborted } from '@/llm/abort.utils';

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

        const completedSeats: number[] = [];
        for (const player of orderedPlayers) {
          throwIfAborted(context.signal);
          const { sceneId, attemptId } = createSceneIdentity(state, player.id, 0);
          let sceneOpened = false;
          let thinkingDurationMs = 0;
          let contentDurationMs = 0;

          let effectStarted = false;
          try {
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.open',
              sceneId,
              attemptId,
              sceneType: 'speech',
              visibility: 'public',
              actorId: player.id,
            });
            sceneOpened = true;

            const position = {
              aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
              day: state.currentDay,
              phase: '普通发言',
              round: 0,
              order: orderedPlayers.map((p) => p.seatNo),
              completedSeats: [...completedSeats],
            };
            const contextData = await this.agentRuntime.prepareContextPublic({
              phaseInstanceId: state.phaseInstanceId,
              gameId: state.gameId,
              playerId: player.id,
              scenario: 'day_speech',
              actionType: 'speech',
              position,
            });

            // 流式输出：思考 + 发言正文
            const result = await this.agentRuntime.streamSpeech(contextData, {
              signal: context.signal,
              onThinking: (token) => {
                context.broadcaster?.emit(state.gameId, {
                  type: 'scene.append',
                  sceneId,
                  attemptId,
                  token,
                  contentType: 'thinking',
                });
              },
              onContent: (token) => {
                context.broadcaster?.emit(state.gameId, {
                  type: 'scene.append',
                  sceneId,
                  attemptId,
                  token,
                  contentType: 'content',
                });
              },
            });

            const { thinking, content } = result;
            thinkingDurationMs = result.thinkingDurationMs;
            contentDurationMs = result.contentDurationMs;

            effectStarted = true;
            const event = await context.eventWriter.writePlayerSpeechEvent({
              source: contextData.source,
              phaseInstanceId: state.phaseInstanceId,
              signal: context.signal,
              turn: { phase: position.phase, round: position.round },
              sceneId,
              sceneType: 'speech',
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              seatNo: player.seatNo,
              content,
              thinking,
            });
            await this.agentRuntime.recordExperienceUsages(contextData, event);
            completedSeats.push(player.seatNo);
          } catch (error) {
            if (effectStarted) failAfterEffect(error);
            failModelCall(error, context, `[发言阶段] ${player.seatNo}号位发言出错`);
          } finally {
            if (sceneOpened) {
              context.broadcaster?.emit(state.gameId, {
                type: 'scene.close',
                sceneId,
                attemptId,
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

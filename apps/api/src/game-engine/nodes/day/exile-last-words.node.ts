import { failAfterEffect, failModelCall } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import { DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import { createSceneIdentity, type NodeContext, type GameNode } from '../node.types';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { throwIfAborted } from '@/llm/abort.utils';

/**
 * 被放逐者遗言节点（流式版本）
 */
@Injectable()
export class ExileLastWordsNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): (context: NodeContext) => GameNode {
    return (context) =>
      async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const exiledPlayer = state.players.find(
          (p) =>
            !p.isAlive &&
            p.deathDay === state.currentDay &&
            p.deathCause === DEATH_CAUSES.EXECUTION,
        );

        if (!exiledPlayer) {
          return {};
        }

        throwIfAborted(context.signal);
        const { sceneId, attemptId } = createSceneIdentity(state, exiledPlayer.id, 0);
        let sceneOpened = false;
        let thinkingDurationMs = 0;
        let contentDurationMs = 0;

        let effectStarted = false;
        try {
          const position = {
            day: state.currentDay,
            phase: '白天放逐遗言',
            order: [exiledPlayer.seatNo],
            completedSeats: [],
            round: 0,
            aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
          };
          const contextData = await this.agentRuntime.prepareContextPublic({
            phaseInstanceId: state.phaseInstanceId,
            gameId: state.gameId,
            playerId: exiledPlayer.id,
            scenario: 'last_words',
            actionType: 'speech',
            position,
          });

          context.broadcaster?.emit(state.gameId, {
            type: 'scene.open',
            sceneId,
            attemptId,
            sceneType: 'last_words',
            visibility: 'public',
            actorId: exiledPlayer.id,
          });
          sceneOpened = true;

          // 流式输出：思考 + 遗言正文
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
            sceneType: 'last_words',
            gameId: state.gameId,
            day: state.currentDay,
            actorId: exiledPlayer.id,
            seatNo: exiledPlayer.seatNo,
            content,
            thinking,
          });
          await this.agentRuntime.recordExperienceUsages(contextData, event);
        } catch (error) {
          if (effectStarted) failAfterEffect(error);
          failModelCall(error, context, `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言异常`);
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

        return {};
      };
  }
}

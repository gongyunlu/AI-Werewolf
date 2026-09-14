import { failAfterEffect, allowModelFallback } from '../../core/game-failure-policy';
import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import { appendSceneNotice, type NodeFactory } from '../node.types';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { throwIfAborted } from '@/llm/abort.utils';

/**
 * PK 发言节点（流式版本）
 */
@Injectable()
export class PkSpeechNode {
  constructor(private readonly agentRuntime: AgentRuntimeService) {}

  create(): NodeFactory {
    return (context) => async (state: GameGraphState) => {
      if (!state.pkCandidates || state.pkCandidates.length === 0) {
        return {};
      }

      const pkPlayers = state.players.filter(
        (p) => p.isAlive && state.pkCandidates!.includes(p.seatNo!),
      );

      pkPlayers.sort((a, b) => a.seatNo! - b.seatNo!);

      const completedSeats: number[] = [];
      const skippedSeats: number[] = [];
      for (const player of pkPlayers) {
        throwIfAborted(context.signal);
        const sceneId = `pk-speech-${state.gameId}-${state.currentDay}-${player.id}`;
        let sceneOpened = false;
        let thinkingDurationMs = 0;
        let contentDurationMs = 0;

        let effectStarted = false;
        try {
          const extraInfo = `你正在进行PK发言。这是第${Math.max(1, state.pkRound)}轮PK，候选人只有${state.pkCandidates!.join('、')}号位。下一轮只允许候选人以外的存活玩家在这些候选人中投票，候选人不能投票，也不能把票改到台外玩家。请结合上一轮公开票型为自己辩护。`;

          const position = {
            aliveSeats: state.players.filter((p) => p.isAlive).map((p) => p.seatNo),
            day: state.currentDay,
            phase: 'PK发言',
            round: Math.max(1, state.pkRound),
            order: pkPlayers.map((p) => p.seatNo),
            completedSeats: [...completedSeats],
            skippedSeats: [...skippedSeats],
          };
          const contextData = await this.agentRuntime.prepareContextPublic({
            gameId: state.gameId,
            playerId: player.id,
            scenario: 'day_speech',
            actionType: 'speech',
            position,
            additionalContext: extraInfo,
          });

          context.broadcaster?.emit(state.gameId, {
            type: 'scene.open',
            sceneId,
            sceneType: 'speech',
            visibility: 'public',
            actorId: player.id,
          });
          sceneOpened = true;

          // 流式输出：思考 + 发言正文
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

          if (!content) {
            skippedSeats.push(player.seatNo);
            continue;
          }
          effectStarted = true;
          const event = await context.eventWriter.writePlayerSpeechEvent({
            turn: { phase: position.phase, round: position.round },
            sceneId,
            sceneType: 'speech',
            gameId: state.gameId,
            day: state.currentDay,
            actorId: player.id,
            seatNo: player.seatNo!,
            content,
            thinking,
          });
          await this.agentRuntime.recordExperienceUsages(contextData, event);
          completedSeats.push(player.seatNo);
        } catch (error) {
          if (effectStarted) failAfterEffect(error);

          await allowModelFallback(error, context, player.id);
          appendSceneNotice(context, state.gameId, sceneId);
          skippedSeats.push(player.seatNo);
          gameLogger.error(
            `[PK发言] ${player.seatNo}号位发言出错: ${error instanceof Error ? error.message : String(error)}`,
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

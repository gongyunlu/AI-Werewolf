import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { isAbortError, throwIfAborted } from '@/agent-runtime/abort.utils';

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

      for (const player of pkPlayers) {
        throwIfAborted(context.signal);
        const sceneId = `pk-speech-${state.gameId}-${state.currentDay}-${player.id}`;
        let sceneOpened = false;
        let thinkingDurationMs = 0;
        let contentDurationMs = 0;

        try {
          const extraInfo = `你正在进行PK发言。这是第${Math.max(1, state.pkRound)}轮PK，候选人只有${state.pkCandidates!.join('、')}号位。下一轮只允许候选人以外的存活玩家在这些候选人中投票，候选人不能投票，也不能把票改到台外玩家。请结合上一轮公开票型为自己辩护。`;

          const contextData = await this.agentRuntime.prepareContextPublic(
            state.gameId,
            player.id,
            'day_speech' as any,
            extraInfo,
          );

          const threadId = getPlayerThreadId(state.gameId, player.id);

          context.broadcaster?.emit(state.gameId, {
            type: 'scene.open',
            sceneId,
            sceneType: 'speech',
            visibility: 'public',
            actorId: player.id,
          });
          sceneOpened = true;

          // 流式输出：思考 + 发言正文
          const result = await this.agentRuntime.streamSpeech(contextData, threadId, {
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

          const event = await context.eventWriter.writePlayerSpeechEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: player.id,
            seatNo: player.seatNo!,
            content,
            thinking,
          });
          await this.agentRuntime.recordExperienceUsages(contextData, event);
        } catch (error) {
          if (isAbortError(error, context.signal)) {
            throw error;
          }
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

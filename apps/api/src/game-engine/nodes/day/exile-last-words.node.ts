import { Injectable } from '@nestjs/common';
import { DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

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

        try {
          const contextData = await this.agentRuntime.prepareContextPublic(
            state.gameId,
            exiledPlayer.id,
            'last_words' as any,
            undefined,
          );

          const threadId = getPlayerThreadId(state.gameId, exiledPlayer.id);

          const sceneId = `exile-last-words-${state.gameId}-${state.currentDay}-${exiledPlayer.id}`;
          context.broadcaster?.emit(state.gameId, {
            type: 'scene.open',
            sceneId,
            sceneType: 'last_words',
            visibility: 'public',
            actorId: exiledPlayer.id,
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

          await context.eventWriter.writePlayerSpeechEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: exiledPlayer.id,
            seatNo: exiledPlayer.seatNo,
            content,
            thinking,
          });
        } catch (error) {
          gameLogger.error(
            `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        return {};
      };
  }
}

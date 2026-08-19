import { Injectable } from '@nestjs/common';
import type { GameGraphState } from '../../core/types';
import type { NodeFactory } from '../node.types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';

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
        try {
          const extraInfo = `你正在进行PK发言。这是第${state.pkRound}轮PK，你需要为自己辩护，说服其他玩家不要投你。`;

          const contextData = await this.agentRuntime.prepareContextPublic(
            state.gameId,
            player.id,
            'day_speech' as any,
            extraInfo,
          );

          const threadId = getPlayerThreadId(state.gameId, player.id);

          const sceneId = `pk-speech-${state.gameId}-${state.currentDay}-${player.id}`;
          context.broadcaster?.emit(state.gameId, {
            type: 'scene.open',
            sceneId,
            sceneType: 'speech',
            visibility: 'public',
            actorId: player.id,
          });

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

          await context.eventWriter.writePlayerSpeechEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: player.id,
            seatNo: player.seatNo!,
            content,
            thinking,
          });
        } catch (error) {
          gameLogger.error(
            `[PK发言] ${player.seatNo}号位发言出错: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return {};
    };
  }
}

import type { NodeFactory } from '../node.types';
import type { GameGraphState } from '../../core/types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import {
  createMakeSpeechTool,
  type MakeSpeechOutput,
} from '@/agent-runtime/tools/make-speech.tool';
import { createSkipActionTool } from '@/agent-runtime/tools/skip-action.tool';
import { gameLogger } from '../../utils/game-logger';

/**
 * PK 发言节点
 *
 * 平票后，PK 候选人进行补充发言
 */
export const createPkSpeechNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
    gameLogger.debug(`[PK发言] Day ${state.currentDay} - PK轮次 ${state.pkRound}`);

    // 检查是否有 PK 候选人
    if (!state.pkCandidates || state.pkCandidates.length === 0) {
      gameLogger.debug('[PK发言] 无PK候选人，跳过');
      return {};
    }

    gameLogger.debug(`[PK发言] PK候选人: ${state.pkCandidates.join(', ')}号位`);

    // 获取 PK 候选人的 Player 对象
    const pkPlayers = state.players.filter(
      (p) => p.isAlive && state.pkCandidates!.includes(p.seatNo!),
    );

    // PK 候选人按座位号顺序发言
    pkPlayers.sort((a, b) => a.seatNo! - b.seatNo!);

    for (const player of pkPlayers) {
      gameLogger.debug(`[PK发言] ${player.seatNo}号位开始PK发言...`);

      try {
        const tools = [
          createMakeSpeechTool({ gameId: state.gameId, currentPlayerId: player.id }),
          createSkipActionTool({ gameId: state.gameId, currentPlayerId: player.id }),
        ];

        const sceneId = `pk-speech-${state.gameId}-${state.currentDay}-${player.id}`;
        const startedAt = Date.now();
        context.broadcaster?.emit(state.gameId, {
          type: 'scene.open',
          sceneId,
          sceneType: 'speech',
          visibility: 'public',
          actorId: player.id,
        });

        const result = await context.agentRuntime.run({
          gameId: state.gameId,
          playerId: player.id,
          scenario: AGENT_SCENARIOS.DAY_SPEECH,
          availableTools: tools,
          maxIterations: 3,
          threadId: getPlayerThreadId(state.gameId, player.id),
          additionalContext: `你正在进行PK发言。这是第${state.pkRound}轮PK，你需要为自己辩护，说服其他玩家不要投你。`,
          onStreamToken: (token, contentType) => {
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.append',
              sceneId,
              token,
              contentType,
            });
          },
        });

        const pkSpeechContent =
          result.success && result.result
            ? ((result.result as MakeSpeechOutput).content ?? '')
            : '';

        // 将工具结果的 content 也流式推送
        if (pkSpeechContent) {
          for (const char of pkSpeechContent) {
            context.broadcaster?.emit(state.gameId, {
              type: 'scene.append',
              sceneId,
              token: char,
              contentType: 'content',
            });
          }
        }

        context.broadcaster?.emit(state.gameId, {
          type: 'scene.close',
          sceneId,
          fullContent: result.thinking
            ? `[思考]\n${result.thinking}\n\n${pkSpeechContent}`
            : pkSpeechContent,
          durationMs: Date.now() - startedAt,
        });

        if (result.success && result.result) {
          const toolResult = result.result as MakeSpeechOutput;

          if (toolResult.action === 'make_speech') {
            gameLogger.debug(`[PK发言] ${player.seatNo}号位: ${toolResult.content}`);

            // 写入 Event 表
            await context.eventWriter.writePlayerSpeechEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              seatNo: player.seatNo!,
              content: toolResult.content,
              thinking: result.thinking,
            });
          } else {
            gameLogger.debug(`[PK发言] ${player.seatNo}号位跳过发言`);
          }
        } else {
          gameLogger.warn(
            `[PK发言] ${player.seatNo}号位 Agent 调用失败。原因: ${result.error || 'success=false 或 result 为空'}`,
          );
        }
      } catch (error) {
        gameLogger.error(
          `[PK发言] ${player.seatNo}号位发言出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    gameLogger.debug('[PK发言] PK发言阶段结束');
    return {};
  };
};

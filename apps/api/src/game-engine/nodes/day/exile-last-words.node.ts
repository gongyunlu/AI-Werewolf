import { AGENT_SCENARIOS, DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { createMakeSpeechTool } from '@/agent-runtime/tools/make-speech.tool';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * 被放逐者遗言节点工厂
 */
export function createExileLastWordsNode(context: NodeContext): GameNode {
  return async (state: GameGraphState): Promise<GameGraphUpdate> => {
    return exileLastWordsNode(state, context);
  };
}

/**
 * 被放逐者遗言节点
 *
 * 被放逐的玩家发表遗言（在 execute 节点之后执行）
 *
 * 规则：
 * - 被放逐者有一次遗言机会
 * - 遗言在放逐执行后、特殊技能触发前
 *
 * @param state 游戏状态
 * @param context 节点上下文
 * @returns 状态更新
 */
async function exileLastWordsNode(
  state: GameGraphState,
  context: NodeContext,
): Promise<GameGraphUpdate> {
  gameLogger.debug(`[被放逐者遗言] Day ${state.currentDay} 开始`);

  // 查询刚被放逐的玩家（deathDay 等于当前天数且 deathCause 为 DEATH_CAUSES.EXECUTION）
  const exiledPlayer = state.players.find(
    (p) => !p.isAlive && p.deathDay === state.currentDay && p.deathCause === DEATH_CAUSES.EXECUTION,
  );

  if (!exiledPlayer) {
    gameLogger.debug(`[被放逐者遗言] 本轮无人被放逐，跳过遗言`);
    return {};
  }

  gameLogger.debug(`[被放逐者遗言] ${exiledPlayer.seatNo}号位开始遗言`);

  // 调用 Agent 生成遗言
  try {
    const tools = [
      createMakeSpeechTool({
        gameId: state.gameId,
        currentPlayerId: exiledPlayer.id,
      }),
    ];

    const sceneId = `exile-last-words-${state.gameId}-${state.currentDay}-${exiledPlayer.id}`;
    const startedAt = Date.now();
    context.broadcaster?.emit(state.gameId, {
      type: 'scene.open',
      sceneId,
      sceneType: 'last_words',
      visibility: 'public',
      actorId: exiledPlayer.id,
    });

    // 缓存玩家快照
    const result = await context.agentRuntime.run({
      gameId: state.gameId,
      playerId: exiledPlayer.id,
      scenario: AGENT_SCENARIOS.LAST_WORDS,
      availableTools: tools,
      maxIterations: 3,
      threadId: getPlayerThreadId(state.gameId, exiledPlayer.id),
      onStreamToken: (token, contentType) => {
        context.broadcaster?.emit(state.gameId, {
          type: 'scene.append',
          sceneId,
          token,
          contentType,
        });
      },
    });

    const speechContent =
      result.success && result.result
        ? ((result.result as { content?: string }).content ?? '')
        : '';

    // 将工具结果的 content 也流式推送
    if (speechContent) {
      for (const char of speechContent) {
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
        ? `[思考]\n${result.thinking}\n\n${speechContent}`
        : speechContent,
      durationMs: Date.now() - startedAt,
    });

    if (result.success && result.result) {
      const toolResult = result.result as { action: string; content?: string };

      if (toolResult.action === 'make_speech' && toolResult.content) {
        gameLogger.debug(`[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言: ${toolResult.content}`);

        // 写入遗言事件
        await context.eventWriter.writePlayerSpeechEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: exiledPlayer.id,
          seatNo: exiledPlayer.seatNo,
          content: toolResult.content,
        });
      } else {
        gameLogger.debug(`[被放逐者遗言] ${exiledPlayer.seatNo}号位选择不发表遗言`);
      }
    } else {
      gameLogger.warn(
        `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言 Agent 调用失败，跳过。原因: ${result.error || 'success=false 或 result 为空'}`,
      );
    }
  } catch (error) {
    gameLogger.error(
      `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  gameLogger.debug(`[被放逐者遗言] 遗言阶段结束`);
  return {};
}

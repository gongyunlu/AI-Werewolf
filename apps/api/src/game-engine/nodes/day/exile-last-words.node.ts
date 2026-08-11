import { Logger } from '@nestjs/common';
import { AGENT_SCENARIOS, DEATH_CAUSES } from '@ai-werewolf/shared';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import type { NodeContext, GameNode } from '../node.types';
import { createMakeSpeechTool } from '@/agent-runtime/tools/make-speech.tool';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';

const logger = new Logger('ExileLastWordsNode');

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
  logger.log(`[被放逐者遗言] Day ${state.currentDay} 开始`);

  // 查询刚被放逐的玩家（deathDay 等于当前天数且 deathCause 为 DEATH_CAUSES.EXECUTION）
  const exiledPlayer = state.players.find(
    (p) => !p.isAlive && p.deathDay === state.currentDay && p.deathCause === DEATH_CAUSES.EXECUTION,
  );

  if (!exiledPlayer) {
    logger.log(`[被放逐者遗言] 本轮无人被放逐，跳过遗言`);
    return {};
  }

  logger.log(`[被放逐者遗言] ${exiledPlayer.seatNo}号位开始遗言`);

  // 调用 Agent 生成遗言
  try {
    const tools = [
      createMakeSpeechTool({
        gameId: state.gameId,
        currentPlayerId: exiledPlayer.id,
      }),
    ];

    const result = await context.agentRuntime.run({
      gameId: state.gameId,
      playerId: exiledPlayer.id,
      scenario: AGENT_SCENARIOS.LAST_WORDS,
      availableTools: tools,
      maxIterations: 3,
      threadId: getPlayerThreadId(state.gameId, exiledPlayer.id),
    });

    if (result.success && result.result) {
      const toolResult = result.result as { action: string; content?: string };

      if (toolResult.action === 'make_speech' && toolResult.content) {
        logger.log(`[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言: ${toolResult.content}`);

        // 写入遗言事件
        await context.eventWriter.writePlayerSpeechEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: exiledPlayer.id,
          seatNo: exiledPlayer.seatNo,
          content: toolResult.content,
        });
      } else {
        logger.log(`[被放逐者遗言] ${exiledPlayer.seatNo}号位选择不发表遗言`);
      }
    } else {
      logger.warn(
        `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言 Agent 调用失败，跳过。原因: ${result.error || 'success=false 或 result 为空'}`,
      );
    }
  } catch (error) {
    logger.error(
      `[被放逐者遗言] ${exiledPlayer.seatNo}号位遗言异常，跳过: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  logger.log(`[被放逐者遗言] 遗言阶段结束`);
  return {};
}

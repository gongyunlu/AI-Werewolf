import type { NodeFactory } from '../node.types';
import type { GameGraphState } from '../../core/types';
import { getPlayerThreadId } from '@/agent-runtime/thread-id.utils';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';
import { createCastVoteTool, type CastVoteOutput } from '@/agent-runtime/tools/cast-vote.tool';
import { resolveVotes } from '../../rules/vote-resolution';
import { gameLogger } from '../../utils/game-logger';

/**
 * 投票节点 - 第一轮投票
 *
 * 所有存活玩家投票，可以弃票
 * 结果：
 * - 唯一最高票 → 设置 exileTarget
 * - 平票 → 设置 pkCandidates，进入 PK 流程
 * - 全体弃票 → exileTarget = null，无人放逐
 */
export const createVoteNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<Partial<GameGraphState>> => {
    gameLogger.debug(`[投票阶段] Day ${state.currentDay} 开始投票`);

    const alivePlayers = state.players.filter((p) => p.isAlive);

    await context.eventWriter.writeJudgeEvent({
      gameId: state.gameId,
      day: state.currentDay,
      content: '发言结束，请所有人开始投票。',
    });

    // 并行投票
    const votePromises = alivePlayers.map(async (player) => {
      gameLogger.debug(`[投票阶段] ${player.seatNo}号位开始投票...`);

      try {
        const tools = [
          createCastVoteTool({
            gameId: state.gameId,
            currentPlayerId: player.id,
            allowAbstain: true, // 普通投票允许弃票
          }),
        ];

        const result = await context.agentRuntime!.run({
          gameId: state.gameId,
          playerId: player.id,
          scenario: AGENT_SCENARIOS.VOTE,
          availableTools: tools,
          maxIterations: 3,
          threadId: getPlayerThreadId(state.gameId, player.id),
        });

        if (result.success && result.result) {
          const toolResult = result.result as CastVoteOutput;

          if (toolResult.action === 'cast_vote') {
            const voteTarget =
              toolResult.targetSeatNo === 0 ? '弃票' : `${toolResult.targetSeatNo}号位`;
            gameLogger.debug(`[投票阶段] ${player.seatNo}号位投票: ${voteTarget}`);

            await context.eventWriter.writePlayerVoteEvent({
              gameId: state.gameId,
              day: state.currentDay,
              actorId: player.id,
              voterSeatNo: player.seatNo,
              targetSeatNo: toolResult.targetSeatNo,
            });

            return {
              voterId: player.id,
              voterSeatNo: player.seatNo,
              targetSeatNo: toolResult.targetSeatNo,
            };
          }
        } else {
          gameLogger.warn(
            `[投票阶段] ${player.seatNo}号位 Agent 调用失败。原因: ${result.error || 'success=false 或 result 为空'}`,
          );
        }
      } catch (error) {
        gameLogger.error(
          `[投票阶段] ${player.seatNo}号位投票出错: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return null;
    });

    // 等待所有投票完成
    const voteResults = await Promise.all(votePromises);
    const votes = voteResults.filter(
      (v): v is { voterId: string; voterSeatNo: number; targetSeatNo: number } => v !== null,
    );

    // 降级策略：如果没有有效投票，视为全体弃票
    if (votes.length === 0) {
      gameLogger.warn('[投票阶段] 无有效投票，降级策略：视为全体弃票');
      return {
        exileTarget: null,
        exileVoteCount: 0,
        pkCandidates: null,
        pkRound: 0,
        lastVoteResults: new Map(),
      };
    }

    // 构建投票数据结构：targetId → voterIds[]
    const votesMap = new Map<string, string[]>();
    for (const vote of votes) {
      // targetSeatNo 为 0 表示弃票
      if (vote.targetSeatNo !== 0) {
        const target = state.players.find((p) => p.seatNo === vote.targetSeatNo);
        if (target) {
          if (!votesMap.has(target.id)) {
            votesMap.set(target.id, []);
          }
          votesMap.get(target.id)!.push(vote.voterId);
        }
      }
    }

    // 检查是否全体弃票（提前返回，避免空调用）
    if (votesMap.size === 0) {
      gameLogger.debug('[投票阶段] 全体弃票，无人被放逐');
      return {
        exileTarget: null,
        exileVoteCount: 0,
        pkCandidates: null,
        pkRound: 0,
        lastVoteResults: new Map(),
      };
    }

    // 获取警长 ID
    const sheriff = state.players.find((p) => p.isSheriff && p.isAlive);
    const sheriffId = sheriff?.id;

    // 调用规则引擎统计票数
    const result = resolveVotes(votesMap, state.players, sheriffId);

    // 构建座位号 → 得票数的映射（用于日志和状态记录）
    const voteCountBySeat = new Map<number, number>();
    for (const [playerId, voterIds] of votesMap.entries()) {
      const player = state.players.find((p) => p.id === playerId);
      if (player) {
        // 计算实际票数（考虑警长权重）
        const count = voterIds.reduce((sum, voterId) => {
          return sum + (sheriffId && voterId === sheriffId ? 1.5 : 1.0);
        }, 0);
        voteCountBySeat.set(player.seatNo, count);
      }
    }

    gameLogger.debug(
      `[投票阶段] 得票统计: ${Array.from(voteCountBySeat.entries())
        .map(([seat, count]) => `${seat}号位(${count}票)`)
        .join(', ')}`,
    );

    // 平票情况
    if (result.isTie) {
      const pkSeatNos = result.tiedPlayerIds
        .map((id) => state.players.find((p) => p.id === id)?.seatNo)
        .filter((seatNo): seatNo is number => seatNo !== undefined);

      gameLogger.debug(`[投票阶段] 平票: ${pkSeatNos.join(', ')}号位，进入PK阶段`);
      return {
        exileTarget: null,
        exileVoteCount: voteCountBySeat.size > 0 ? Math.max(...voteCountBySeat.values()) : 0,
        pkCandidates: pkSeatNos,
        pkRound: (state.pkRound || 0) + 1,
        lastVoteResults: voteCountBySeat,
      };
    }

    // 唯一得票最高者，直接放逐
    const exiledPlayer = state.players.find((p) => p.id === result.executedPlayerId);

    if (!exiledPlayer) {
      throw new Error(`[投票阶段] 数据一致性错误：未找到玩家 ${result.executedPlayerId}`);
    }

    gameLogger.debug(`[投票阶段] 放逐目标: ${exiledPlayer.seatNo}号位 (${exiledPlayer.id})`);
    return {
      exileTarget: exiledPlayer.id,
      exileVoteCount: voteCountBySeat.get(exiledPlayer.seatNo) || 0,
      pkCandidates: null,
      pkRound: 0,
      lastVoteResults: voteCountBySeat,
    };
  };
};

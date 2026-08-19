import { FACTIONS } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState, PlayerState } from '../../core/types';
import type { NodeContext } from '../node.types';
import { getWolfTeamThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * 狼人刀人决策 Schema
 */
const ProposeKillDecisionSchema = z.object({
  action: z.enum(['propose_kill']),
  targetSeatNo: z.number().int().describe('要刀的座位号'),
  reason: z.string().optional().describe('选择该目标的理由（可选）'),
});

type ProposeKillDecision = {
  action: 'propose_kill';
  targetSeatNo: number;
  reason?: string;
};

/**
 * 讨论记录
 */
interface DiscussionMessage {
  speakerId: string;
  seatNo: number;
  content: string;
  round: number;
}

/**
 * 投票记录
 */
interface VoteRecord {
  voterId: string;
  voterSeatNo: number;
  targetSeatNo: number;
  reason?: string;
}

/**
 * 单狼决策（两阶段版本）
 */
export async function singleWolfDecision(
  wolf: PlayerState,
  state: GameGraphState,
  context: NodeContext,
): Promise<string | null> {
  try {
    const contextData = await context.agentRuntime.prepareContextPublic(
      state.gameId,
      wolf.id,
      'night_action' as any,
      undefined,
    );

    const wolfThreadId = getWolfTeamThreadId(state.gameId);

    // 阶段1：流式推理
    const reasoning = await context.agentRuntime.streamReasoning(
      contextData,
      wolfThreadId,
      undefined,
      (_token) => {
        // 可选：SSE 推送推理过程
      },
    );

    // 阶段2：生成决策
    const decision = await context.agentRuntime.generateDecision<ProposeKillDecision>(
      contextData,
      reasoning,
      ProposeKillDecisionSchema,
      undefined,
      wolfThreadId,
    );

    if (decision.action === 'propose_kill') {
      const targetPlayer = state.players.find((p) => p.seatNo === decision.targetSeatNo);

      if (!targetPlayer) {
        throw new Error(`[单狼决策] 数据一致性错误：未找到目标玩家 ${decision.targetSeatNo}号位`);
      }

      return targetPlayer.id;
    }

    gameLogger.warn(`[单狼决策] ${wolf.seatNo}号位未做出决策`);
    return null;
  } catch (error) {
    gameLogger.error(
      `[单狼决策] ${wolf.seatNo}号位决策失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * 判断是否需要继续讨论（保持不变）
 */
async function shouldContinueDiscussion(
  discussionHistory: DiscussionMessage[],
  context: NodeContext,
  _state: GameGraphState,
  currentRound: number,
  maxRounds: number,
): Promise<boolean> {
  if (currentRound >= maxRounds) {
    return false;
  }

  if (discussionHistory.length === 0) {
    return true;
  }

  if (discussionHistory.length < 2) {
    return true;
  }

  const summary = discussionHistory.map((msg) => `${msg.seatNo}号位: ${msg.content}`).join('\n');

  const prompt = `
你是狼人杀游戏的协调者。请分析以下狼人讨论内容，判断他们是否已经达成共识，可以进入投票环节。

讨论内容：
${summary}

判断标准：
1. 所有狼人都明确表达了同意刀某个目标（例如"同意刀3号位"、"就刀3号位"）
2. 没有明显的分歧或争议
3. 讨论已经收敛到一个具体的行动方案

如果所有狼人都明确同意了一个目标，回答 NO（不需要继续讨论）。
如果还有分歧或没有达成一致，回答 YES（需要继续讨论）。

只输出 YES 或 NO，不要解释。
  `.trim();

  try {
    const { ChatOpenAI } = await import('@langchain/openai');
    const model = new ChatOpenAI({
      apiKey: context.configService.get('ARK_API_KEY', { infer: true }),
      model: context.configService.get('ARK_DEFAULT_MODEL', { infer: true }),
      configuration: { baseURL: context.configService.get('ARK_BASE_URL', { infer: true }) },
      temperature: 0,
    });

    const response = await model.invoke(prompt);
    const decision = response.content.toString().trim().toUpperCase();

    return decision === 'YES';
  } catch (error) {
    gameLogger.error(`[狼人讨论] 协调判断失败:`, error);
    return currentRound < maxRounds;
  }
}

/**
 * 狼人讨论阶段（两阶段版本）
 */
export async function wolfDiscussion(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
): Promise<DiscussionMessage[]> {
  const discussionHistory: DiscussionMessage[] = [];
  const speechCount = new Map<string, number>();

  const maxRounds = 2;
  const maxSpeechPerWolf = 2;

  for (let round = 0; round < maxRounds; round++) {
    const shuffled = [...werewolves].toSorted(() => Math.random() - 0.5);

    for (const wolf of shuffled) {
      const currentSpeechCount = speechCount.get(wolf.id) || 0;

      if (currentSpeechCount >= maxSpeechPerWolf) {
        continue;
      }

      const previousDiscussion =
        discussionHistory.length > 0
          ? `
## 队友的发言
${discussionHistory.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}
`.trim()
          : '';

      const wolfThreadId = getWolfTeamThreadId(state.gameId);

      try {
        const sceneId = `wolf-discussion-${state.gameId}-${state.currentDay}-${round}-${wolf.id}`;
        context.broadcaster?.emit(state.gameId, {
          type: 'scene.open',
          sceneId,
          sceneType: 'night_action',
          visibility: 'wolf',
          actorId: wolf.id,
        });

        const contextData = await context.agentRuntime.prepareContextPublic(
          state.gameId,
          wolf.id,
          'night_action' as any,
          previousDiscussion,
        );

        // 流式输出：思考 + 讨论发言正文
        const { thinking, content, thinkingDurationMs, contentDurationMs } =
          await context.agentRuntime.streamSpeech(contextData, wolfThreadId, {
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

        if (content) {
          discussionHistory.push({
            speakerId: wolf.id,
            seatNo: wolf.seatNo,
            content,
            round: round + 1,
          });
          speechCount.set(wolf.id, currentSpeechCount + 1);

          await context.eventWriter.writeWolfDiscussionEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: wolf.id,
            seatNo: wolf.seatNo,
            content,
            round: round + 1,
            thinking,
          });
        }
      } catch (error) {
        gameLogger.error(
          `[狼人讨论] ${wolf.seatNo}号位发言失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const shouldContinue = await shouldContinueDiscussion(
      discussionHistory,
      context,
      state,
      round + 1,
      maxRounds,
    );

    if (!shouldContinue) {
      break;
    }
  }

  return discussionHistory;
}

/**
 * 狼人投票阶段（两阶段版本）
 */
export async function wolfVoting(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
  discussion: DiscussionMessage[],
): Promise<VoteRecord[]> {
  const discussionSummary =
    discussion.length > 0
      ? `
## 刚才的讨论内容
${discussion.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}
`.trim()
      : '';

  const votePromises = werewolves.map(async (wolf): Promise<VoteRecord | null> => {
    const wolfThreadId = getWolfTeamThreadId(state.gameId);

    try {
      const contextData = await context.agentRuntime.prepareContextPublic(
        state.gameId,
        wolf.id,
        'night_action' as any,
        discussionSummary,
      );

      // 阶段1：流式推理
      const reasoning = await context.agentRuntime.streamReasoning(
        contextData,
        wolfThreadId,
        undefined,
      );

      // 阶段2：生成投票决策
      const decision = await context.agentRuntime.generateDecision<ProposeKillDecision>(
        contextData,
        reasoning,
        ProposeKillDecisionSchema,
        undefined,
        wolfThreadId,
      );

      if (decision.action === 'propose_kill') {
        return {
          voterId: wolf.id,
          voterSeatNo: wolf.seatNo,
          targetSeatNo: decision.targetSeatNo,
          reason: decision.reason,
        };
      } else {
        gameLogger.warn(`[狼人投票] ${wolf.seatNo}号位未投票`);
      }
    } catch (error) {
      gameLogger.error(
        `[狼人投票] ${wolf.seatNo}号位投票失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return null;
  });

  const voteResults = await Promise.all(votePromises);
  const votes: VoteRecord[] = voteResults.filter((v): v is VoteRecord => v !== null);

  return votes;
}

/**
 * 统计投票结果，确定刀人目标（逻辑不变）
 */
export function selectTargetFromVotes(votes: VoteRecord[], state: GameGraphState): string | null {
  if (votes.length === 0) {
    gameLogger.warn('[狼人投票] 无有效投票，随机选择目标');
    const villagers = state.players.filter((p) => p.isAlive && p.faction === FACTIONS.VILLAGER);
    if (villagers.length > 0) {
      const randomTarget = villagers[Math.floor(Math.random() * villagers.length)];
      return randomTarget.id;
    }
    return null;
  }

  const voteCount = new Map<number, number>();
  votes.forEach((v) => {
    voteCount.set(v.targetSeatNo, (voteCount.get(v.targetSeatNo) || 0) + 1);
  });

  const maxVotes = Math.max(...voteCount.values());
  const candidates = Array.from(voteCount.entries())
    .filter(([_, count]) => count === maxVotes)
    .map(([seatNo]) => seatNo);

  const targetSeatNo = candidates[Math.floor(Math.random() * candidates.length)];

  const player = state.players.find((p) => p.seatNo === targetSeatNo);
  if (!player) {
    throw new Error(`[狼人投票] 数据一致性错误：未找到目标玩家 ${targetSeatNo}号位`);
  }
  return player.id;
}

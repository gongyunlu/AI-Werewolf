import { createHash } from 'node:crypto';
import { FACTIONS } from '@ai-werewolf/shared';
import { z } from 'zod';
import type { GameGraphState, PlayerState } from '../../core/types';
import type { NodeContext } from '../node.types';
import { getWolfTeamThreadId } from '@/agent-runtime/thread-id.utils';
import { PROMPT_NAMES } from '@/observability/prompt-templates';
import { gameLogger } from '../../utils/game-logger';
import { isAbortError, throwIfAborted } from '@/agent-runtime/abort.utils';
import { readExperiment } from '@/evaluation/experiment-snapshot';

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
 * 狼队夜间协作的场景锚定。
 *
 * 狼队商议与预言家查验、女巫用药共用 night_action 场景，但前者是「多人协作、产出刀人目标」，
 * 后者是「单人技能使用」。弱模型在 night_action 的通用指令下会把商议混淆成白天发言
 * （输出悍跳稿而非讨论刀谁），故在 additionalContext 里补一段锚定，区分夜间私下交流
 * 与白天公开发言。
 */
const WOLF_NIGHT_ANCHOR = `## 当前阶段：狼队夜间行动
你现在和狼队友在夜间私下交流（这段内容仅狼队可见）。本阶段核心是确定今晚刀谁，
其次是安排明天白天的战术分工。注意：这是夜间私下商议，不是白天公开发言，
不要在这里输出白天的发言稿。`;

/**
 * 单狼决策（理由与动作一并生成）
 */
export async function singleWolfDecision(
  wolf: PlayerState,
  state: GameGraphState,
  context: NodeContext,
  proposalEventIds: string[] = [],
): Promise<string | null> {
  try {
    const contextData = await context.agentRuntime.prepareContextPublic(
      state.gameId,
      wolf.id,
      'night_action' as any,
      undefined,
    );

    const wolfThreadId = getWolfTeamThreadId(state.gameId);

    const { reasoning, decision } = await context.agentRuntime.decide<ProposeKillDecision>(
      contextData,
      ProposeKillDecisionSchema,
      context.signal,
      wolfThreadId,
    );

    if (decision.action === 'propose_kill') {
      const targetPlayer = state.players.find((p) => p.seatNo === decision.targetSeatNo);

      if (!targetPlayer || !targetPlayer.isAlive) {
        throw new Error(`[单狼决策] 数据一致性错误：未找到目标玩家 ${decision.targetSeatNo}号位`);
      }

      const event = await context.eventWriter.writeWolfDecisionEvent({
        gameId: state.gameId,
        day: state.currentDay,
        actorId: wolf.id,
        actionType: 'wolf_proposal',
        content: { targetSeatNo: decision.targetSeatNo, seatNo: wolf.seatNo, thinking: reasoning },
      });
      await context.agentRuntime.recordExperienceUsages(contextData, event);
      proposalEventIds.push(event.id);
      return targetPlayer.id;
    }

    gameLogger.warn(`[单狼决策] ${wolf.seatNo}号位未做出决策`);
    return null;
  } catch (error) {
    if (isAbortError(error, context.signal)) {
      throw error;
    }
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
  state: GameGraphState,
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

  try {
    const game = await context.prisma.game.findUnique({
      where: { id: state.gameId },
      select: { experiment: true },
    });
    const experiment = readExperiment(game?.experiment);
    const coordinationPrompt = await context.promptService.render(
      PROMPT_NAMES.wolfCoordination,
      {
        discussion: summary,
      },
      experiment?.prompts,
    );

    const { ChatOpenAI } = await import('@langchain/openai');
    const modelName =
      experiment?.auxiliaryModel ??
      context.configService.getOrThrow('ARK_DEFAULT_MODEL', { infer: true });
    const model = new ChatOpenAI({
      apiKey: context.configService.get('ARK_API_KEY', { infer: true }),
      model: modelName,
      configuration: { baseURL: context.configService.get('ARK_BASE_URL', { infer: true }) },
      temperature: 0,
    });

    const response = await model.invoke(coordinationPrompt.text, {
      signal: context.signal,
      ...context.langfuse.trace({
        runName: 'wolf-coordination',
        gameId: state.gameId,
        playerId: state.gameId, // 协调判断不绑定单个玩家，以 gameId 兜底
        modelName,
        scenario: 'night_action',
        promptName: coordinationPrompt.name,
        promptVersion: coordinationPrompt.version,
      }),
    });
    const decision = response.content.toString().trim().toUpperCase();

    return decision === 'YES';
  } catch (error) {
    if (isAbortError(error, context.signal)) {
      throw error;
    }
    gameLogger.error(`[狼人讨论] 协调判断失败:`, error);
    return currentRound < maxRounds;
  }
}

/**
 * 狼人讨论阶段（流式发言）
 */
export async function wolfDiscussion(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
): Promise<DiscussionMessage[]> {
  const discussionHistory: DiscussionMessage[] = [];
  const speechCount = new Map<string, number>();

  const game = await context.prisma.game.findUnique({
    where: { id: state.gameId },
    select: { experiment: true },
  });
  const experiment = readExperiment(game?.experiment);
  const maxRounds = 2;
  const maxSpeechPerWolf = 2;

  for (let round = 0; round < maxRounds; round++) {
    const shuffled = experiment
      ? pairedWolfOrder(werewolves, experiment.pairId, state.currentDay, round)
      : [...werewolves].toSorted(() => Math.random() - 0.5);

    for (const wolf of shuffled) {
      throwIfAborted(context.signal);
      const currentSpeechCount = speechCount.get(wolf.id) || 0;

      if (currentSpeechCount >= maxSpeechPerWolf) {
        continue;
      }

      const previousDiscussion =
        discussionHistory.length > 0
          ? `${WOLF_NIGHT_ANCHOR}\n\n## 队友的发言\n${discussionHistory.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}`
          : WOLF_NIGHT_ANCHOR;

      const wolfThreadId = getWolfTeamThreadId(state.gameId);

      const sceneId = `wolf-discussion-${state.gameId}-${state.currentDay}-${round}-${wolf.id}`;
      let sceneOpened = false;
      let thinkingDurationMs = 0;
      let contentDurationMs = 0;

      try {
        context.broadcaster?.emit(state.gameId, {
          type: 'scene.open',
          sceneId,
          sceneType: 'night_action',
          visibility: 'wolf',
          actorId: wolf.id,
        });
        sceneOpened = true;

        const contextData = await context.agentRuntime.prepareContextPublic(
          state.gameId,
          wolf.id,
          'night_action' as any,
          previousDiscussion,
        );

        // 流式输出：思考 + 讨论发言正文
        const result = await context.agentRuntime.streamSpeech(contextData, wolfThreadId, {
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

        if (content) {
          discussionHistory.push({
            speakerId: wolf.id,
            seatNo: wolf.seatNo,
            content,
            round: round + 1,
          });
          speechCount.set(wolf.id, currentSpeechCount + 1);

          const event = await context.eventWriter.writeWolfDiscussionEvent({
            gameId: state.gameId,
            day: state.currentDay,
            actorId: wolf.id,
            seatNo: wolf.seatNo,
            content,
            round: round + 1,
            thinking,
          });
          await context.agentRuntime.recordExperienceUsages(contextData, event);
        }
      } catch (error) {
        if (isAbortError(error, context.signal)) {
          throw error;
        }
        gameLogger.error(
          `[狼人讨论] ${wolf.seatNo}号位发言失败: ${error instanceof Error ? error.message : String(error)}`,
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
 * 狼人投票阶段（理由与动作一并生成）
 */
export async function wolfVoting(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
  discussion: DiscussionMessage[],
  proposalEventIds: string[] = [],
): Promise<VoteRecord[]> {
  const discussionSummary =
    discussion.length > 0
      ? `${WOLF_NIGHT_ANCHOR}\n\n## 刚才的讨论内容\n${discussion.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}`
      : WOLF_NIGHT_ANCHOR;

  const votePromises = werewolves.map(async (wolf): Promise<VoteRecord | null> => {
    const wolfThreadId = getWolfTeamThreadId(state.gameId);

    try {
      const contextData = await context.agentRuntime.prepareContextPublic(
        state.gameId,
        wolf.id,
        'night_action' as any,
        discussionSummary,
      );

      const { reasoning, decision } = await context.agentRuntime.decide<ProposeKillDecision>(
        contextData,
        ProposeKillDecisionSchema,
        context.signal,
        wolfThreadId,
      );

      if (decision.action === 'propose_kill') {
        if (!state.players.some((p) => p.isAlive && p.seatNo === decision.targetSeatNo))
          throw new Error('狼刀目标不存活');
        const event = await context.eventWriter.writeWolfDecisionEvent({
          gameId: state.gameId,
          day: state.currentDay,
          actorId: wolf.id,
          actionType: 'wolf_proposal',
          content: {
            targetSeatNo: decision.targetSeatNo,
            seatNo: wolf.seatNo,
            thinking: reasoning,
          },
        });
        await context.agentRuntime.recordExperienceUsages(contextData, event);
        proposalEventIds.push(event.id);
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
      if (isAbortError(error, context.signal)) {
        throw error;
      }
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

/** 同一配对使用相同座位排序键，不依赖各局 Player UUID 或墙钟。 */
export function pairedWolfOrder<T extends { seatNo: number }>(
  wolves: T[],
  pairId: string,
  day: number,
  round: number,
): T[] {
  const key = (wolf: T) =>
    createHash('sha256').update([pairId, day, round, wolf.seatNo].join(':')).digest('hex');
  return wolves.toSorted((a, b) => key(a).localeCompare(key(b)) || a.seatNo - b.seatNo);
}

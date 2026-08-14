import { AGENT_SCENARIOS, FACTIONS } from '@ai-werewolf/shared';
import type { GameGraphState, PlayerState } from '../../core/types';
import type { NodeContext } from '../node.types';
import { createWolfChatTool, type WolfChatOutput } from '@/agent-runtime/tools/werewolf.tool';
import { createProposeKillTool, type ProposeKillOutput } from '@/agent-runtime/tools/werewolf.tool';
import { getWolfTeamThreadId } from '@/agent-runtime/thread-id.utils';
import { gameLogger } from '../../utils/game-logger';

/**
 * Agent Thinking 记录
 *
 * 用于前端展示 Agent 的推理过程
 *
 * TODO Thinking 存储和查询接口
 *
 * @example
 * const thinking: AgentThinking = {
 *   playerId: wolf.id,
 *   playerSeatNo: wolf.seatNo,
 *   role: 'werewolf',
 *   scenario: 'wolf_kill',
 *   thinkingProcess: result.thinking || '',
 *   finalDecision: `刀 ${toolResult.targetSeatNo}号位`,
 *   timestamp: new Date(),
 * };
 * await context.eventWriter?.writeAgentThinking(thinking);
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface AgentThinking {
  playerId: string;
  playerSeatNo: number;
  role: string;
  scenario: string; // 'wolf_kill' | 'seer_check' | 'witch_decision'
  thinkingProcess: string; // Agent 的推理过程
  finalDecision: string; // 最终决策
  timestamp: Date;
}

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
 * 单狼决策
 *
 * 当只剩一只狼时，不需要讨论和投票，直接思考决策
 *
 * 关键：保留 Agent 的 Thinking 过程，供前端展示
 *
 * @param wolf 最后一只狼
 * @param state 游戏状态
 * @param context 节点上下文
 * @returns 目标玩家 ID
 */
export async function singleWolfDecision(
  wolf: PlayerState,
  state: GameGraphState,
  context: NodeContext,
): Promise<string | null> {
  gameLogger.debug(`[单狼决策] ${wolf.seatNo}号位独自决策`);

  // 只给 propose_kill 工具
  const tools = [createProposeKillTool({ gameId: state.gameId, currentPlayerId: wolf.id })];

  try {
    const result = await context.agentRuntime.run({
      gameId: state.gameId,
      playerId: wolf.id,
      scenario: AGENT_SCENARIOS.NIGHT_ACTION,
      availableTools: tools,
      maxIterations: 8, // 增加迭代次数，单狼决策需要充分思考
    });

    if (result.success && result.result) {
      const toolResult = result.result as ProposeKillOutput;

      if (toolResult.action === 'propose_kill') {
        const targetPlayer = state.players.find((p) => p.seatNo === toolResult.targetSeatNo);

        if (!targetPlayer) {
          throw new Error(
            `[单狼决策] 数据一致性错误：未找到目标玩家 ${toolResult.targetSeatNo}号位`,
          );
        }

        gameLogger.debug(
          `[单狼决策] ${wolf.seatNo}号位决定刀 ${toolResult.targetSeatNo}号位${toolResult.reason ? `: ${toolResult.reason}` : ''}`,
        );

        // TODO：保存 Thinking 到数据库或 Event 表
        // const thinking: AgentThinking = {
        //   playerId: wolf.id,
        //   playerSeatNo: wolf.seatNo,
        //   role: 'werewolf',
        //   scenario: 'wolf_kill',
        //   thinkingProcess: result.thinking || '',
        //   finalDecision: `刀 ${toolResult.targetSeatNo}号位`,
        //   timestamp: new Date(),
        // };
        // await context.eventWriter?.writeAgentThinking(thinking);

        return targetPlayer.id;
      }
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
 * 判断是否需要继续讨论
 *
 * 分析当前讨论历史，判断狼人是否已经达成共识
 */
async function shouldContinueDiscussion(
  discussionHistory: DiscussionMessage[],
  context: NodeContext,
  state: GameGraphState,
  currentRound: number,
  maxRounds: number,
): Promise<boolean> {
  // 如果已经是最后一轮，直接返回 false
  if (currentRound >= maxRounds) {
    return false;
  }

  // 如果没有任何发言，继续讨论
  if (discussionHistory.length === 0) {
    return true;
  }

  // 如果只有1条发言，继续讨论让其他狼人回应
  if (discussionHistory.length < 2) {
    return true;
  }

  // 构建讨论摘要
  const summary = discussionHistory.map((msg) => `${msg.seatNo}号位: ${msg.content}`).join('\n');

  // 使用 LLM 判断是否达成共识
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
    // 从环境变量直接读取配置（临时方案）
    const { ChatOpenAI } = await import('@langchain/openai');
    const model = new ChatOpenAI({
      apiKey: process.env.ARK_API_KEY,
      model: process.env.ARK_DEFAULT_MODEL || 'ep-20241227185357-9cq77',
      configuration: { baseURL: process.env.ARK_BASE_URL },
      temperature: 0,
    });

    const response = await model.invoke(prompt);
    const decision = response.content.toString().trim().toUpperCase();

    gameLogger.debug(
      `[狼人讨论] 协调判断: ${decision} (${decision === 'YES' ? '继续讨论' : '进入投票'})`,
    );

    return decision === 'YES';
  } catch (error) {
    gameLogger.error(`[狼人讨论] 协调判断失败:`, error);
    // 降级：如果判断失败，按原有逻辑继续
    return currentRound < maxRounds;
  }
}

/**
 * 狼人讨论阶段
 *
 * 规则：
 * - 最多 2 轮讨论
 * - 每只狼最多发言 2 次
 * - 随机顺序发言
 *
 * @param werewolves 存活的狼人列表
 * @param state 游戏状态
 * @param context 节点上下文
 * @returns 讨论历史
 */
export async function wolfDiscussion(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
): Promise<DiscussionMessage[]> {
  const discussionHistory: DiscussionMessage[] = [];
  const speechCount = new Map<string, number>(); // 记录每只狼的发言次数

  const maxRounds = 2;
  const maxSpeechPerWolf = 2;

  gameLogger.debug(`[狼人讨论] 开始讨论，共 ${werewolves.length} 只狼，最多 ${maxRounds} 轮`);

  for (let round = 0; round < maxRounds; round++) {
    gameLogger.debug(`[狼人讨论] 第 ${round + 1} 轮讨论`);

    // 随机顺序发言
    const shuffled = [...werewolves].toSorted(() => Math.random() - 0.5);

    for (const wolf of shuffled) {
      const currentSpeechCount = speechCount.get(wolf.id) || 0;

      // 检查是否超过发言次数限制
      if (currentSpeechCount >= maxSpeechPerWolf) {
        gameLogger.debug(`[狼人讨论] ${wolf.seatNo}号位已发言 ${currentSpeechCount} 次，跳过`);
        continue;
      }

      // 构建工具
      // 狼人讨论不允许跳过，必须发言协调
      const tools = [createWolfChatTool({ gameId: state.gameId, currentPlayerId: wolf.id })];

      // 构建之前的讨论记录（人类可读格式）
      const previousDiscussion =
        discussionHistory.length > 0
          ? `
## 队友的发言
${discussionHistory.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}
`.trim()
          : '';

      // 狼人讨论使用团队共享的 threadId，与个人白天发言隔离
      const wolfThreadId = getWolfTeamThreadId(state.gameId);

      try {
        const result = await context.agentRuntime.run({
          gameId: state.gameId,
          playerId: wolf.id,
          scenario: AGENT_SCENARIOS.NIGHT_ACTION,
          availableTools: tools,
          maxIterations: 8, // 增加迭代次数，狼人讨论需要充分思考和协调
          threadId: wolfThreadId,
          additionalContext: previousDiscussion, // 注入之前的讨论记录
        });

        if (result.success && result.result) {
          const toolResult = result.result as WolfChatOutput | { action: 'skip_discussion' };

          if (toolResult.action === 'wolf_chat') {
            const msg = toolResult as WolfChatOutput;
            discussionHistory.push({
              speakerId: wolf.id,
              seatNo: wolf.seatNo,
              content: msg.message,
              round: round + 1,
            });
            speechCount.set(wolf.id, currentSpeechCount + 1);
            gameLogger.debug(`[狼人讨论] ${wolf.seatNo}号位: ${msg.message}`);
          } else {
            gameLogger.debug(`[狼人讨论] ${wolf.seatNo}号位跳过发言`);
          }
        }
      } catch (error) {
        gameLogger.error(
          `[狼人讨论] ${wolf.seatNo}号位发言失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 每轮讨论后，判断是否需要继续
    const shouldContinue = await shouldContinueDiscussion(
      discussionHistory,
      context,
      state,
      round + 1,
      maxRounds,
    );

    if (!shouldContinue) {
      gameLogger.debug(`[狼人讨论] 协调判断: 已达成共识，提前结束讨论`);
      break;
    }
  }

  gameLogger.debug(`[狼人讨论] 讨论结束，共 ${discussionHistory.length} 条发言`);
  return discussionHistory;
}

/**
 * 狼人投票阶段
 *
 * 每只狼根据讨论历史，投票决定刀人目标
 *
 * @param werewolves 存活的狼人列表
 * @param state 游戏状态
 * @param context 节点上下文
 * @param _discussion 讨论历史（预留参数，Phase 8.5+ 用于上下文注入）
 * @returns 投票记录
 */
export async function wolfVoting(
  werewolves: PlayerState[],
  state: GameGraphState,
  context: NodeContext,
  discussion: DiscussionMessage[],
): Promise<VoteRecord[]> {
  gameLogger.debug(`[狼人投票] 开始投票，共 ${werewolves.length} 只狼`);

  // 构建讨论记录（所有狼人共享）
  const discussionSummary =
    discussion.length > 0
      ? `
## 刚才的讨论内容
${discussion.map((msg) => `- ${msg.seatNo}号位: ${msg.content}`).join('\n')}
`.trim()
      : '';

  // 并行投票：所有狼人同时投票，互不可见
  const votePromises = werewolves.map(async (wolf): Promise<VoteRecord | null> => {
    // 只给 propose_kill 工具
    const tools = [createProposeKillTool({ gameId: state.gameId, currentPlayerId: wolf.id })];

    // 狼人投票使用团队共享的 threadId，与个人白天发言隔离
    const wolfThreadId = getWolfTeamThreadId(state.gameId);

    try {
      const result = await context.agentRuntime.run({
        gameId: state.gameId,
        playerId: wolf.id,
        scenario: AGENT_SCENARIOS.NIGHT_ACTION,
        availableTools: tools,
        maxIterations: 8, // 增加迭代次数，狼人投票需要充分思考
        threadId: wolfThreadId,
        additionalContext: discussionSummary, // 只注入讨论记录，不包含其他人的投票
      });

      if (result.success && result.result) {
        const toolResult = result.result as ProposeKillOutput;

        if (toolResult.action === 'propose_kill') {
          gameLogger.debug(
            `[狼人投票] ${wolf.seatNo}号位投票刀 ${toolResult.targetSeatNo}号位${toolResult.reason ? `: ${toolResult.reason}` : ''}`,
          );
          return {
            voterId: wolf.id,
            voterSeatNo: wolf.seatNo,
            targetSeatNo: toolResult.targetSeatNo,
            reason: toolResult.reason,
          };
        }
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

  // 等待所有投票完成
  const voteResults = await Promise.all(votePromises);
  const votes: VoteRecord[] = voteResults.filter((v): v is VoteRecord => v !== null);

  gameLogger.debug(`[狼人投票] 投票结束，共收到 ${votes.length} 票`);
  return votes;
}

/**
 * 统计投票结果，确定刀人目标
 *
 * 规则：
 * - 得票最多的目标被选中
 * - 平票时随机选择一个
 *
 * @param votes 投票记录
 * @param state 游戏状态
 * @returns 目标玩家 ID，如果没有有效投票则返回 null
 */
export function selectTargetFromVotes(votes: VoteRecord[], state: GameGraphState): string | null {
  if (votes.length === 0) {
    gameLogger.warn('[狼人投票] 无有效投票，随机选择目标');
    // 随机选择一个好人
    const villagers = state.players.filter((p) => p.isAlive && p.faction === FACTIONS.VILLAGER);
    if (villagers.length > 0) {
      const randomTarget = villagers[Math.floor(Math.random() * villagers.length)];
      gameLogger.debug(`[狼人投票] 随机选择 ${randomTarget.seatNo}号位`);
      return randomTarget.id;
    }
    return null;
  }

  // 统计票数
  const voteCount = new Map<number, number>();
  votes.forEach((v) => {
    voteCount.set(v.targetSeatNo, (voteCount.get(v.targetSeatNo) || 0) + 1);
  });

  // 找到最高票数
  const maxVotes = Math.max(...voteCount.values());
  const candidates = Array.from(voteCount.entries())
    .filter(([_, count]) => count === maxVotes)
    .map(([seatNo]) => seatNo);

  // 平票随机选择
  const targetSeatNo = candidates[Math.floor(Math.random() * candidates.length)];

  gameLogger.debug(
    `[狼人投票] ${targetSeatNo}号位得票最多 (${maxVotes}票)${candidates.length > 1 ? '，平票随机选择' : ''}`,
  );

  // 转换为 playerId
  const player = state.players.find((p) => p.seatNo === targetSeatNo);
  if (!player) {
    throw new Error(`[狼人投票] 数据一致性错误：未找到目标玩家 ${targetSeatNo}号位`);
  }
  return player.id;
}

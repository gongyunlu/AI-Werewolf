import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, type ActiveMemory, type SimilarMemory } from '../memory/memory.service';
import { GlobalMemoryService, type ActivePattern } from '../memory/global-memory.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import { LangfuseService, type TraceConfig } from '../observability/langfuse.service';
import { PromptService } from '../observability/prompt.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import type { Env } from '../config/env.validation';
import { resolveStructuredOutputMethod } from '../observability/structured-output-method';
import { Prisma } from '../generated/prisma/client';
import { getVisibleVisibilitiesForRole } from '../game-engine/rules/visibility';
import {
  ACTION_TYPES,
  AGENT_SCENARIOS,
  FACTIONS,
  ROLES,
  SEER_CHECK_RESULTS,
  VISIBILITY_TYPES,
  type AgentScenario,
} from '@ai-werewolf/shared';
import { isAbortError, throwIfAborted } from './abort.utils';
import { formatMemorySection } from './memory-prompt.utils';
import { buildScenarioQuery } from './scenario-query';
import { ChatHistoryService } from './chat-history.service';

/**
 * lesson 场景匹配阈值：与当前局面的余弦相似度不低于此值，才把注入记为 trigger 命中。
 * 质量分 lift 只统计命中样本，避免「注入了不相关经验」被算作该行为的收益。
 * 初值待跑出真实相似度分布后校准。
 */
const LESSON_TRIGGER_MATCH_SIMILARITY = 0.5;

type PlayerWithGame = Prisma.PlayerGetPayload<{
  include: { game: true };
}>;

type EventRecord = Prisma.EventGetPayload<Record<string, never>>;
type Event = EventRecord;

/**
 * 分层上下文
 */
interface LayeredContext {
  critical: string; // 关键信息（当前状态）
  recent: string; // 最近一轮详细
  history: string; // 历史摘要
}

/**
 * Agent 上下文（prepareContext 的产物，贯穿两阶段决策）
 */
interface AgentContext {
  systemPrompt: string;
  player: PlayerWithGame;
  game: Prisma.GameGetPayload<Record<string, never>>;
  /** 当前场景 */
  scenario: AgentScenario;
  /** 已注入 Prompt、待行为 Event 成功落库后确认的记忆使用关系 */
  pendingMemoryUsages: Array<{ memoryId: string; triggerMatched: boolean }>;
}

/**
 * Agent Runtime Service - 两阶段决策模式
 *
 * 1. prepareContext - 准备上下文
 * 2. buildLayeredContext - 分层记忆
 * 3. assembleSystemPrompt - 组装 System Prompt（包含 Skill）
 * 4. streamReasoning - 阶段1：流式输出推理过程
 * 5. generateDecision - 阶段2：生成结构化决策
 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly globalMemoryService: GlobalMemoryService,
    private readonly skillLoader: SkillLoaderService,
    private readonly speechSummarizer: SpeechSummarizerService,
    private readonly langfuse: LangfuseService,
    private readonly promptService: PromptService,
    private readonly chatHistory: ChatHistoryService,
  ) {}

  /**
   * 阶段1：流式输出角色推理过程（纯文本思考）
   *
   * @param context 已准备好的上下文（包含 systemPrompt、player、game）
   * @param threadId 会话 ID
   * @param signal 中断信号
   * @param onStreamToken 流式 token 回调
   * @param onStreamComplete 流式完成回调
   * @returns 推理文本内容
   */
  async streamReasoning(
    context: AgentContext,
    threadId: string,
    signal?: AbortSignal,
    onStreamToken?: (token: string) => void,
    onStreamComplete?: (fullContent: string) => void,
  ): Promise<string> {
    throwIfAborted(signal);
    const modelName = context.player.modelName;
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: !!onStreamToken,
      modelKwargs: {
        thinking: { type: 'enabled' },
        reasoning_effort: 'medium',
      },
    });

    // 渲染推理指令 prompt，版本关联到本次 trace
    const humanPrompt = await this.promptService.render(PROMPT_NAMES.agentReasoning);

    const trace = this.langfuse.trace({
      runName: 'reasoning',
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
      promptName: humanPrompt.name,
      promptVersion: humanPrompt.version,
    });

    const history = await this.loadHistory(threadId);

    const humanMessage = new HumanMessage(humanPrompt.text);
    const messages: BaseMessage[] = [
      new SystemMessage(context.systemPrompt),
      ...history,
      humanMessage,
    ];

    let fullContent = '';

    if (onStreamToken) {
      const stream = await model.stream(messages, { signal, ...trace });

      for await (const chunk of stream) {
        throwIfAborted(signal);

        if (typeof chunk.content === 'string' && chunk.content) {
          fullContent += chunk.content;
          onStreamToken(chunk.content);
        }

        const reasoningContent = (chunk.additional_kwargs as any)?.reasoning_content;
        if (typeof reasoningContent === 'string' && reasoningContent) {
          fullContent += reasoningContent;
          onStreamToken(reasoningContent);
        }
      }

      if (onStreamComplete) {
        onStreamComplete(fullContent);
      }
    } else {
      throwIfAborted(signal);
      const response = await model.invoke(messages, { signal, ...trace });

      const responseReasoning = (response.additional_kwargs as any)?.reasoning_content;
      if (typeof responseReasoning === 'string' && responseReasoning.trim()) {
        fullContent = responseReasoning;
      } else if (typeof response.content === 'string' && response.content.trim()) {
        fullContent = response.content;
      }
    }

    return fullContent;
  }

  /**
   * 单次自然语言流式调用（不使用 thinking 模式 / reasoning_content / Structured Output）
   *
   * @param model 已配置 streaming 的模型实例
   * @param messages 消息列表
   * @param signal 中断信号
   * @param onToken 流式 token 回调（可空，仅用于实时转发）
   * @param trace 追踪配置（未启用追踪时 callbacks 为空数组）
   * @returns 完整文本
   */
  private async streamPlainChat(
    model: ChatOpenAI,
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
    onToken?: (token: string) => void,
    trace?: TraceConfig,
  ): Promise<string> {
    let fullContent = '';
    const stream = await model.stream(messages, { signal, ...trace });

    for await (const chunk of stream) {
      throwIfAborted(signal);

      if (typeof chunk.content === 'string' && chunk.content) {
        fullContent += chunk.content;
        onToken?.(chunk.content);
      }
    }

    return fullContent;
  }

  /**
   * 发言类场景：流式输出「思考」与「正文」
   *
   * 两段自然语言流式调用，均以 content 字段流式输出（不使用 reasoning_content、
   * Structured Output 或工具调用），满足「后端直接转发 LLM 真实流」的需求。
   *
   * @param context 已准备好的上下文
   * @param threadId 会话 ID
   * @param options.onThinking 思考 token 回调
   * @param options.onContent 正文 token 回调
   * @returns 思考与正文完整文本
   */
  async streamSpeech(
    context: AgentContext,
    threadId: string,
    options: {
      signal?: AbortSignal;
      onThinking?: (token: string) => void;
      onContent?: (token: string) => void;
    } = {},
  ): Promise<{
    thinking: string;
    content: string;
    thinkingDurationMs: number;
    contentDurationMs: number;
  }> {
    const { signal, onThinking, onContent } = options;
    throwIfAborted(signal);
    const startTime = Date.now();
    const modelName = context.player.modelName;

    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: true,
    });

    const traceParams = {
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
    };
    const history = await this.loadHistory(threadId);

    const thinkingPrompt = await this.promptService.render(PROMPT_NAMES.agentSpeechThinking);
    const thinkingTrace = this.langfuse.trace({
      runName: 'speech-thinking',
      ...traceParams,
      promptName: thinkingPrompt.name,
      promptVersion: thinkingPrompt.version,
    });
    const thinkingMessages = [
      new SystemMessage(context.systemPrompt),
      ...history,
      new HumanMessage(thinkingPrompt.text),
    ];

    // 阶段1：流式输出思考
    const thinking = await this.streamPlainChat(
      model,
      thinkingMessages,
      signal,
      onThinking,
      thinkingTrace,
    );

    throwIfAborted(signal);
    const contentStartTime = Date.now();
    const contentPrompt = await this.promptService.render(PROMPT_NAMES.agentSpeechContent, {
      thinking,
    });
    const contentTrace = this.langfuse.trace({
      runName: 'speech-content',
      ...traceParams,
      promptName: contentPrompt.name,
      promptVersion: contentPrompt.version,
    });
    const contentMessages = [
      new SystemMessage(context.systemPrompt),
      new HumanMessage(contentPrompt.text),
    ];

    // 阶段2：流式输出发言正文
    const content = await this.streamPlainChat(
      model,
      contentMessages,
      signal,
      onContent,
      contentTrace,
    );

    const contentEndTime = Date.now();
    return {
      thinking,
      content,
      thinkingDurationMs: contentStartTime - startTime,
      contentDurationMs: contentEndTime - contentStartTime,
    };
  }

  /**
   * 阶段2：根据推理结果生成结构化决策
   *
   * @param context 已准备好的上下文
   * @param reasoning 阶段1的推理文本
   * @param zodSchema 决策的 Zod Schema
   * @param signal 中断信号
   * @returns 结构化决策对象
   */
  async generateDecision<T = any>(
    context: AgentContext,
    reasoning: string,
    zodSchema: z.ZodType,
    signal?: AbortSignal,
    threadId?: string,
  ): Promise<T> {
    throwIfAborted(signal);
    const modelName = context.player.modelName;
    const baseModel = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: false,
    });

    // GLM 系列不支持 json_schema，须走 functionCalling；其余默认 jsonSchema（见 resolveStructuredOutputMethod）
    const model = baseModel.withStructuredOutput(zodSchema, {
      method: resolveStructuredOutputMethod(modelName),
    });

    const [systemPrompt, userPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.agentDecisionSystem, {
        systemPrompt: context.systemPrompt,
      }),
      this.promptService.render(PROMPT_NAMES.agentDecisionUser, {
        reasoning,
      }),
    ]);

    const trace = this.langfuse.trace({
      runName: 'decision',
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
      promptName: userPrompt.name,
      promptVersion: userPrompt.version,
    });

    const baseMessages: BaseMessage[] = [
      new SystemMessage(systemPrompt.text),
      new HumanMessage(userPrompt.text),
    ];

    // function calling 模式下，模型不调用工具会抛异常（而非返回非法对象），
    // 单次重试兜底，仍失败则抛给上层降级处理。
    let decision: unknown;
    try {
      decision = await model.invoke(baseMessages, { signal, ...trace });
    } catch (error) {
      if (isAbortError(error, signal)) {
        throw error;
      }
      this.logger.warn(
        `[决策] ${modelName} 结构化输出失败，触发单次重试: ${error instanceof Error ? error.message : String(error)}`,
      );
      decision = await model.invoke(baseMessages, {
        signal,
        ...this.langfuse.trace({
          runName: 'decision-retry',
          gameId: context.player.gameId,
          playerId: context.player.id,
          modelName,
          scenario: context.scenario,
          seatNo: context.player.seatNo,
          role: context.player.role,
          promptName: userPrompt.name,
          promptVersion: userPrompt.version,
        }),
      });
    }

    // Zod 兜底校验：结构已由 structured output 层保证，此处仅做字段级校验
    decision = zodSchema.parse(decision);

    // 保存决策结论到跨轮记忆（只存结论，不存推理过程）
    if (threadId) {
      const history = await this.loadHistory(threadId);
      await this.saveHistory(threadId, [
        ...history,
        new AIMessage(`决策结果：${JSON.stringify(decision)}`),
      ]);
    }

    return decision as T;
  }

  /**
   * 获取玩家可见的 visibility 列表
   *
   * 根据玩家角色返回该玩家有权看到的 Event visibility 类型
   *
   * @param player 玩家对象
   * @param events 事件列表（用于判断女巫是否使用过药物）
   * @returns 可见的 visibility 列表
   */
  private async getVisibleVisibilities(player: PlayerWithGame, events: Event[]): Promise<string[]> {
    return getVisibleVisibilitiesForRole({
      role: player.role,
      isAlive: !player.deathDay, // deathDay 为 null 表示存活
      hasUsedAntidote: events.some(
        (e) =>
          e.actionType === ACTION_TYPES.WITCH_SAVE &&
          e.actorId === player.id &&
          (e.content as { saved?: boolean } | null)?.saved === true,
      ),
    });
  }

  /**
   * 步骤 1: Prepare Context（准备上下文）- 公开版本
   *
   * 供外部调用（如 Node 层），用于两阶段模式
   */
  async prepareContextPublic(
    gameId: string,
    playerId: string,
    scenario: AgentScenario,
    additionalContext?: string,
  ): Promise<AgentContext> {
    return this.prepareContext({
      gameId,
      playerId,
      scenario,
      additionalContext,
    });
  }

  /**
   * 行为 Event 成功写入后确认本次真正使用的经验。
   *
   * 同一个 Event 可能因节点/队列重试重复确认，数据库的 (memoryId, eventId) 唯一约束负责幂等。
   * actor/game 不匹配说明调用方把上下文绑到了别人的事件上，宁可丢弃观测数据也不能错记 reward。
   */
  async recordExperienceUsages(
    context: AgentContext,
    event: Pick<EventRecord, 'id' | 'gameId' | 'actorId' | 'actionType' | 'day'>,
  ): Promise<void> {
    if (context.pendingMemoryUsages.length === 0) return;
    if (
      event.gameId !== context.game.id ||
      event.actorId !== context.player.id ||
      event.day === null
    ) {
      this.logger.warn(
        {
          eventId: event.id,
          eventGameId: event.gameId,
          eventActorId: event.actorId,
          contextGameId: context.game.id,
          contextPlayerId: context.player.id,
        },
        '记忆使用关系与行为事件不匹配，已跳过记录',
      );
      return;
    }

    await this.memoryService.recordUsages(
      context.pendingMemoryUsages.map((usage) => ({
        ...usage,
        eventId: event.id,
        gameId: event.gameId,
        playerId: context.player.id,
        scenario: context.scenario,
        actionType: event.actionType,
        day: event.day!,
      })),
    );
  }

  async validateRequiredSkills(options: {
    rulesetId: string;
    skillVersion: string;
    roles: string[];
  }): Promise<void> {
    const scenarioSkillIds = [
      'scenarios/night-action',
      'scenarios/day-speech',
      'scenarios/vote',
      'scenarios/last-words',
      'scenarios/sheriff-decide-order',
    ];
    const roleSkillIds = [...new Set(options.roles)].map((role) => `roles/${role}`);
    const skillIds = [`rulesets/${options.rulesetId}`, ...scenarioSkillIds, ...roleSkillIds];

    await Promise.all(
      skillIds.map((skillId) =>
        this.skillLoader.loadRequiredSkill(skillId, options.skillVersion || 'v1'),
      ),
    );
  }

  /**
   * 步骤 1: Prepare Context（准备上下文）
   *
   * 1. 查询 Player + Game
   * 2. 查询 Event 历史（按权限过滤）
   * 3. 查询 Memory（persona, strategy, skill, rule）
   * 4. 构建分层上下文
   * 5. 组装 System Prompt
   */
  private async prepareContext(input: {
    gameId: string;
    playerId: string;
    scenario: AgentScenario;
    additionalContext?: string;
  }): Promise<AgentContext> {
    const { gameId, playerId, scenario, additionalContext } = input;

    // 1. 查询 Player + Game
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player || player.gameId !== gameId) {
      throw new Error('玩家不存在或不属于该对局');
    }

    // 2. 查询 Event 历史（按权限过滤）
    // 女巫需要先查询所有事件来判断是否使用过解药
    let events: Event[];

    if (player.role === ROLES.WITCH) {
      // 女巫：先查询所有事件，判断是否使用过解药
      const allEvents = await this.prisma.event.findMany({
        where: { gameId },
        orderBy: { sequence: 'asc' },
      });

      // 获取可见的 visibility 列表（包含状态判断）
      const visibleVisibilities = await this.getVisibleVisibilities(player, allEvents);

      // 按 visibility 过滤事件
      events = allEvents.filter((e) => visibleVisibilities.includes(e.visibility));
    } else {
      // 其他角色：直接按 visibility 过滤
      const visibleVisibilities = await this.getVisibleVisibilities(player, []);
      events = await this.prisma.event.findMany({
        where: {
          gameId,
          visibility: { in: visibleVisibilities },
        },
        orderBy: { sequence: 'asc' },
      });
    }

    // 投票是并发同时执行：决策时点不应看到本轮其他人的投票，避免视角泄漏
    if (scenario === AGENT_SCENARIOS.VOTE) {
      const voteDay = await this.getCurrentRound(gameId, events);
      events = events.filter((e) => !(e.actionType === ACTION_TYPES.VOTE && e.day === voteDay));
    }

    // 3. 查询 Memory
    const memories = await this.memoryService.retrieveActiveMemories(
      player.agentId,
      player.memoryLabelSnapshot,
      { types: ['persona', 'strategy'] },
    );

    // 4. 构建分层上下文
    const layeredContext = await this.buildLayeredContext({
      player,
      events,
    });

    // 5. 生成个性化发言摘要（所有场景）
    let speechSummary = '';
    const currentDay = await this.getCurrentRound(gameId, events);
    // 发言可见性由 visibility 决定（public 发言含遗言对存活玩家依然可见），
    // 不能按「发言者是否存活」过滤，否则已出局玩家的遗言会被整段丢弃。
    const otherPlayers = await this.prisma.player.findMany({
      where: {
        gameId,
        id: { not: playerId }, // 排除自己
      },
      select: { seatNo: true },
    });

    // 3.1 检索历史经验（独立于 persona/strategy，见 MemoryService.retrieveExperience）
    const opponents = await this.prisma.player.findMany({
      where: { gameId, id: { not: playerId } },
      select: { agentId: true },
    });
    const experience = await this.memoryService.retrieveExperience({
      agentId: player.agentId,
      label: player.memoryLabelSnapshot,
      opponentAgentIds: opponents.map((o) => o.agentId),
      query: buildScenarioQuery({
        role: player.role,
        scenario,
        day: currentDay,
        events,
      }),
      role: player.role,
      scenario,
    });
    const pendingMemoryUsages = this.buildPendingMemoryUsages(experience);

    // 全局板子规律：跨对局晋升验证，与身份无关，全量注入所有玩家
    const globalPatterns = await this.globalMemoryService.retrieveActivePatterns();

    const visiblePlayerSeats = otherPlayers
      .map((p) => p.seatNo)
      .filter((seatNo): seatNo is number => seatNo !== null);

    // 使用个性化摘要（纯读组装，摘要与判断已由 daySummary 节点统一生成）
    const personalSummary = await this.speechSummarizer.summarizeForAgent(
      gameId,
      currentDay,
      player.agentId,
      visiblePlayerSeats,
    );

    speechSummary = this.formatPersonalSummary(personalSummary);

    // 狼人白天发言：注入夜间商量原文（仅狼队可见，保密标注）
    const wolfDiscussionContext =
      scenario === AGENT_SCENARIOS.DAY_SPEECH && player.role === ROLES.WEREWOLF
        ? this.buildWolfDiscussionContext(events, currentDay)
        : '';

    // 6. 组装 System Prompt
    const systemPrompt = await this.assembleSystemPrompt({
      scenario,
      player,
      memories,
      experience,
      globalPatterns,
      context: layeredContext,
      additionalContext: [speechSummary, wolfDiscussionContext, additionalContext]
        .filter(Boolean)
        .join('\n\n'),
    });

    return {
      systemPrompt,
      player,
      game: player.game,
      scenario,
      pendingMemoryUsages,
    };
  }

  /** 把已注入的经验暂存在上下文；只有真实行为 Event 落库后才会确认成 MemoryUsage。 */
  private buildPendingMemoryUsages(experience: {
    lessons: SimilarMemory[];
    playerModels: ActiveMemory[];
  }): Array<{ memoryId: string; triggerMatched: boolean }> {
    return [
      ...experience.lessons.map((m) => ({
        memoryId: m.id,
        // lesson 按场景语义匹配注入，相似度达阈值才算 trigger 命中
        triggerMatched: m.similarity >= LESSON_TRIGGER_MATCH_SIMILARITY,
      })),
      ...experience.playerModels.map((m) => ({
        memoryId: m.id,
        // 对手建模已按本局同桌过滤，命中即是场景匹配
        triggerMatched: true,
      })),
    ];
  }

  /**
   * 步骤 1.1: Build Layered Context（构建分层上下文）
   *
   * 三层信息：
   * 1. 关键信息 - 当前状态（存活玩家、当前天数）
   * 2. 最近一轮详细 - 上一轮的完整信息
   * 3. 历史摘要 - 更早的关键事件摘要
   */
  private async buildLayeredContext(options: {
    player: PlayerWithGame;
    events: EventRecord[];
  }): Promise<LayeredContext> {
    const { player, events } = options;
    const currentDay = await this.getCurrentRound(player.gameId, events);

    // 1. 关键信息：当前状态
    const alivePlayers = await this.prisma.player.findMany({
      where: {
        gameId: player.gameId,
        deathDay: null,
      },
      select: { seatNo: true, displayName: true },
      orderBy: { seatNo: 'asc' },
    });

    const critical = `
      当前是第 ${currentDay} 天\n
      存活玩家：${alivePlayers.map((p) => `${p.seatNo}号位(${p.displayName})`).join('、')}
    `.trim();

    // 2. 最近一轮详细：当天的所有事件
    const recentEvents = events.filter((e) => e.day === currentDay);

    // speech 统一由 SpeechSummarizerService 处理，不在此重复
    const recent =
      recentEvents.length > 0
        ? recentEvents
            .map((e) => {
              const content = e.content as any;
              switch (e.actionType) {
                case ACTION_TYPES.WOLF_KILL:
                  return `- 狼人刀了 ${content.targetSeatNo}号位`;
                case ACTION_TYPES.SEER_CHECK:
                  return `- 预言家查验了 ${content.targetSeatNo}号位，结果：${content.result}`;
                case ACTION_TYPES.WITCH_SAVE:
                  return content.saved
                    ? `- 女巫使用了解药救 ${content.targetSeatNo}号位`
                    : '- 女巫未使用解药';
                case ACTION_TYPES.WITCH_POISON:
                  return content.used
                    ? `- 女巫使用了毒药毒 ${content.targetSeatNo}号位`
                    : '- 女巫未使用毒药';
                case ACTION_TYPES.SPEECH:
                  // 发言统一由 SpeechSummarizerService 处理
                  return null;
                case ACTION_TYPES.VOTE:
                  return `- ${content.voterSeatNo}号位投票给 ${content.targetSeatNo}号位`;
                case ACTION_TYPES.PLAYER_DIED:
                  return `- 死亡公告：${content.deaths?.map((d: any) => `${d.seatNo}号位`).join('、')}`;
                default:
                  return `- ${e.actionType}`;
              }
            })
            .filter(Boolean)
            .join('\n')
        : '暂无';

    // 3. 历史摘要：之前几天的关键事件
    const historyEvents = events.filter((e) => e.day && e.day < currentDay);
    const history =
      historyEvents.length > 0
        ? historyEvents
            .filter((e) =>
              (
                [
                  ACTION_TYPES.WOLF_KILL,
                  ACTION_TYPES.SEER_CHECK,
                  ACTION_TYPES.PLAYER_DIED,
                  ACTION_TYPES.PLAYER_EXECUTED,
                ] as string[]
              ).includes(e.actionType),
            )
            .map((e) => {
              const content = e.content as any;
              const dayLabel = e.day ?? 0;
              switch (e.actionType) {
                case ACTION_TYPES.WOLF_KILL:
                  return `Day ${dayLabel}: 狼人刀了 ${content.targetSeatNo}号位`;
                case ACTION_TYPES.SEER_CHECK:
                  return `Day ${dayLabel}: 预言家查验 ${content.targetSeatNo}号位 → ${content.result}`;
                case ACTION_TYPES.PLAYER_DIED:
                  return `Day ${dayLabel}: 死亡 ${content.deaths?.map((d: any) => `${d.seatNo}号位`).join('、')}`;
                case ACTION_TYPES.PLAYER_EXECUTED:
                  return `Day ${dayLabel}: 放逐 ${content.targetSeatNo}号位`;
                default:
                  return '';
              }
            })
            .filter(Boolean)
            .join('\n')
        : '暂无';

    return { critical, recent, history };
  }

  /**
   * 狼人白天发言：提取夜间商量原文，附带保密标注
   *
   * 夜间商量内容仅狼队可见（好人是不知道的）。白天发言时狼人需要据此安排战术，
   * 但绝不能直接说出"我们昨晚商量/刀了X"这类暴露狼队身份的话，故加标注提醒。
   */
  private buildWolfDiscussionContext(events: Event[], currentDay: number): string {
    const wolfSpeeches = events.filter(
      (e) =>
        e.visibility === VISIBILITY_TYPES.WOLF &&
        e.actionType === ACTION_TYPES.SPEECH &&
        e.day === currentDay,
    );

    if (wolfSpeeches.length === 0) {
      return '';
    }

    const lines = wolfSpeeches.map((e) => {
      const content = e.content as any;
      return `- ${content.seatNo}号位：${content.speech}`;
    });

    return `
      ## 你们狼队昨晚的夜间商量（机密，仅狼队可见）
      ${lines.join('\n')}

      注意：以上是你们狼队夜间私下商量的内容，好人是不知道的。白天发言时你可以据此安排战术（谁悍跳、谁冲锋、谁倒钩），但绝不能直接说出"我们昨晚商量/刀了X"这类暴露狼队身份的话。
    `.trim();
  }

  /**
   * 步骤 1.2: Assemble System Prompt（组装 System Prompt）
   *
   * 组装结构（骨架走 PromptService 模板，动态内容按变量注入）：
   * - 行为约束 / 核心决策框架 / 基础规则：内联在模板正文
   * - 板子规则：按 rulesetId 加载（rulesets/standard6p）
   * - 场景指令：按 scenario 加载（scenarios/day-speech 等）
   * - 角色玩法：按 player.role 加载（roles/werewolf 等）
   * - 人设 + 策略：从 memories 提取
   * - 角色特定历史（预言家查验记录）+ 分层上下文
   */
  private async assembleSystemPrompt(options: {
    scenario: AgentScenario;
    player: PlayerWithGame;
    memories: ActiveMemory[];
    experience: { lessons: ActiveMemory[]; playerModels: ActiveMemory[] };
    globalPatterns: ActivePattern[];
    context: LayeredContext;
    additionalContext?: string;
  }): Promise<string> {
    const { scenario, player, memories, experience, globalPatterns, context, additionalContext } =
      options;

    // 获取游戏的技能版本
    const skillVersion = player.game.skillVersion || 'v1';

    // 当前板子规则（按 rulesetId 加载，例如 rulesets/standard6p）
    const rulesetSkill = await this.skillLoader.loadRequiredSkill(
      `rulesets/${player.game.rulesetId}`,
      skillVersion,
    );
    const rulesetRules = rulesetSkill.content;

    // 场景指令（根据当前 scenario 加载）
    const scenarioMap: Record<AgentScenario, string> = {
      [AGENT_SCENARIOS.NIGHT_ACTION]: 'scenarios/night-action',
      [AGENT_SCENARIOS.DAY_SPEECH]: 'scenarios/day-speech',
      [AGENT_SCENARIOS.VOTE]: 'scenarios/vote',
      [AGENT_SCENARIOS.LAST_WORDS]: 'scenarios/last-words',
      [AGENT_SCENARIOS.SHERIFF_DECIDE_ORDER]: 'scenarios/sheriff-decide-order',
    };
    const scenarioSkillId = scenarioMap[scenario];
    const scenarioSkill = await this.skillLoader.loadRequiredSkill(scenarioSkillId, skillVersion);
    const scenarioPrompt = scenarioSkill.content;

    // 角色玩法正文（按 player.role 条件加载，例如 roles/werewolf）
    const roleSkill = await this.skillLoader.loadRequiredSkill(
      `roles/${player.role}`,
      skillVersion,
    );
    const roleSkillContent = roleSkill.content;

    // 基础角色信息（只告诉玩家自己的身份）
    const roleView = `
      你是：${player.displayName}\n
      座位号：${player.seatNo}\n
      你的角色：${player.role}\n
      你的阵营：${player.faction === FACTIONS.WEREWOLF ? '狼人阵营' : player.faction === FACTIONS.THIRD_PARTY ? '第三方阵营' : '好人阵营'}\n
      存活状态：${player.deathDay === null ? '存活' : '已出局'}\n
    `.trim();

    // 如果是狼人，注入队友信息
    let teammateInfo = '';
    if (player.role === ROLES.WEREWOLF) {
      const teammates = await this.prisma.player.findMany({
        where: {
          gameId: player.gameId,
          role: ROLES.WEREWOLF,
          id: { not: player.id }, // 排除自己
        },
        select: { seatNo: true, displayName: true },
        orderBy: { seatNo: 'asc' },
      });

      if (teammates.length > 0) {
        teammateInfo = `\n## 你的狼人队友\n${teammates.map((t) => `- ${t.seatNo}号位(${t.displayName})`).join('\n')}\n`;
      }
    }

    // 提取人设和策略记忆
    const personaMemory = formatMemorySection(memories, 'persona');
    const strategyMemory = formatMemorySection(memories, 'strategy');

    // 往期对局沉淀的经验：教训在前（指导本次决策），对手建模在后（识人参考）
    const experienceSection = [
      formatMemorySection(experience.lessons, 'lesson'),
      formatMemorySection(experience.playerModels, 'player_model'),
    ]
      .filter(Boolean)
      .join('\n\n');

    // 跨对局晋升的全局板子规律，渲染格式与经验一致
    const globalPatternSection = globalPatterns
      .map((p) => `### ${p.title}\n${p.content}`)
      .join('\n\n');

    // 角色特定历史信息
    let roleSpecificInfo = '';

    // 预言家：查验历史
    if (player.role === ROLES.SEER) {
      const history = await this.getSeerCheckHistory(player.gameId, player.id);
      if (history) {
        roleSpecificInfo = `\n## 你的查验历史\n${history}\n`;
      }
    }

    // 组合完整 System Prompt（渐进式披露），骨架模板走 PromptService 便于在线调整
    const fullPrompt = await this.promptService.render(PROMPT_NAMES.agentSystemPrompt, {
      roleView,
      teammateInfo,
      scenarioPrompt,
      roleSkill: roleSkillContent,
      additionalContext: additionalContext ? `\n${additionalContext}\n` : '',
      rulesetRules,
      persona: personaMemory || '暂无',
      strategy: strategyMemory || '暂无',
      globalPattern: globalPatternSection || '暂无',
      experience: experienceSection || '暂无',
      roleSpecificInfo,
      critical: context.critical,
      recent: context.recent,
      history: context.history,
    });

    return fullPrompt.text;
  }

  /**
   * 获取预言家历史查验记录
   */
  private async getSeerCheckHistory(gameId: string, _playerId: string): Promise<string> {
    const checkEvents = await this.prisma.event.findMany({
      where: {
        gameId,
        actionType: ACTION_TYPES.SEER_CHECK,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (checkEvents.length === 0) {
      return '';
    }

    const history = checkEvents
      .map((e) => {
        const content = e.content as { targetSeatNo: number; result: string };
        const result = content.result === SEER_CHECK_RESULTS.WEREWOLF ? '狼人' : '好人';
        return `  - ${content.targetSeatNo}号位：${result}`;
      })
      .join('\n');

    return `你已查验过以下玩家：\n${history}`;
  }

  /**
   * 加载会话历史
   */
  private async loadHistory(threadId: string): Promise<BaseMessage[]> {
    try {
      return await this.chatHistory.load(threadId);
    } catch (error) {
      this.logger.warn(
        `加载会话历史失败: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  /**
   * 保存会话历史
   */
  private async saveHistory(threadId: string, messages: BaseMessage[]): Promise<void> {
    try {
      // 滑动窗口：只保留最近 N 条消息，避免跨轮记忆无限增长
      const HISTORY_WINDOW = 20;
      const trimmed =
        messages.length > HISTORY_WINDOW
          ? messages.slice(messages.length - HISTORY_WINDOW)
          : messages;

      await this.chatHistory.replace(threadId, trimmed);
    } catch (error) {
      this.logger.warn(
        `保存会话历史失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 获取当前天数
   */
  private async getCurrentRound(gameId: string, events: EventRecord[]): Promise<number> {
    if (events.length === 0) {
      const latestEvent = await this.prisma.event.findFirst({
        where: { gameId },
        orderBy: { day: 'desc' },
        select: { day: true },
      });
      return latestEvent?.day ?? 1;
    }
    const days = events.map((e) => e.day).filter((d): d is number => d !== null);
    return days.length > 0 ? Math.max(...days) : 1;
  }

  /**
   * 格式化个性化摘要
   */
  private formatPersonalSummary(summary: {
    recentSpeeches: Array<{ day: number; seatNo: number; speech: string }>;
    olderSpeechesSummary: Array<{ day: number; seatNo: number; summary: string }>;
    recentJudgments: Array<{
      speaker: number;
      trustScore: number;
      suspicious: boolean;
      notes: string;
    }>;
    olderJudgmentsSummary: Array<{
      seatNo: number;
      latestTrustScore: number;
      notes: string;
    }>;
  }): string {
    const parts: string[] = [];

    // 近2天完整发言
    if (summary.recentSpeeches.length > 0) {
      parts.push(`## 近2天发言记录`);

      // 按天分组
      const byDay = new Map<number, Array<{ seatNo: number; speech: string }>>();
      for (const s of summary.recentSpeeches) {
        if (!byDay.has(s.day)) {
          byDay.set(s.day, []);
        }
        byDay.get(s.day)!.push({ seatNo: s.seatNo, speech: s.speech });
      }

      // 按天输出
      for (const [day, speeches] of Array.from(byDay.entries()).toSorted((a, b) => a[0] - b[0])) {
        parts.push(`\n### Day ${day}`);
        for (const s of speeches) {
          parts.push(`- ${s.seatNo}号位：${s.speech}`);
        }
      }
    }

    // 2天以前的发言摘要
    if (summary.olderSpeechesSummary.length > 0) {
      parts.push(`\n## 历史发言摘要（2天前）`);
      for (const s of summary.olderSpeechesSummary) {
        parts.push(`- Day ${s.day} ${s.seatNo}号位：${s.summary}`);
      }
    }

    // 我的分析（近2天）
    if (summary.recentJudgments.length > 0) {
      parts.push(`\n## 我的分析（近2天）`);
      for (const j of summary.recentJudgments) {
        parts.push(
          `- ${j.speaker}号位：信任度${j.trustScore}%${j.suspicious ? '（可疑）' : ''} - ${j.notes}`,
        );
      }
    }

    // 我的历史分析（2天以前摘要）
    if (summary.olderJudgmentsSummary.length > 0) {
      parts.push(`\n## 我的历史分析（摘要）`);
      for (const j of summary.olderJudgmentsSummary) {
        parts.push(`- ${j.seatNo}号位：最新信任度${j.latestTrustScore}% - ${j.notes}`);
      }
    }

    return parts.join('\n');
  }
}

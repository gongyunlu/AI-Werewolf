import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, type ActiveMemory } from '../memory/memory.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import { PostgresChatMessageHistory } from '@langchain/community/stores/message/postgres';
import type { Env } from '../config/env.validation';
import { Prisma } from '../generated/prisma/client';
import { Pool } from 'pg';
import {
  ACTION_TYPES,
  AGENT_SCENARIOS,
  FACTIONS,
  PURPOSES,
  ROLES,
  SEER_CHECK_RESULTS,
  VISIBILITY_TYPES,
  type AgentScenario,
} from '@ai-werewolf/shared';

type PlayerWithGame = Prisma.PlayerGetPayload<{
  include: { game: true };
}>;

type EventRecord = Prisma.EventGetPayload<Record<string, never>>;
type Event = EventRecord;

/**
 * Agent 输入
 */

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
  /** 当前场景，用于映射 ModelCall.purpose */
  scenario?: AgentScenario;
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
export class AgentRuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRuntimeService.name);
  private pool: Pool | null = null;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly skillLoader: SkillLoaderService,
    private readonly speechSummarizer: SpeechSummarizerService,
  ) {}

  /**
   * 模块初始化时创建连接池
   */
  async onModuleInit() {
    const databaseUrl = this.configService.get('DATABASE_URL');
    if (databaseUrl) {
      this.pool = new Pool({ connectionString: databaseUrl });
    }
  }

  /**
   * 模块销毁时关闭连接池
   */
  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
    }
  }

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
    const startTime = Date.now();
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

    // 加载会话历史
    const history = await this.loadHistory(threadId);

    const humanMessage = new HumanMessage(
      '你已明确自己的身份、阵营与队友（见系统提示）。请直接基于当前局势进行推理，输出你的下一步判断与理由，不要重复介绍身份或队友。',
    );
    const messages: BaseMessage[] = [
      new SystemMessage(context.systemPrompt),
      ...history,
      humanMessage,
    ];

    let fullContent = '';

    if (onStreamToken) {
      const stream = await model.stream(messages, { signal });

      for await (const chunk of stream) {
        if (signal?.aborted) {
          throw new Error('LLM generation aborted');
        }

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
      const response = await model.invoke(messages, { signal });

      const responseReasoning = (response.additional_kwargs as any)?.reasoning_content;
      if (typeof responseReasoning === 'string' && responseReasoning.trim()) {
        fullContent = responseReasoning;
      } else if (typeof response.content === 'string' && response.content.trim()) {
        fullContent = response.content;
      }
    }

    // 记录调用 + 保存历史（跨轮记忆）
    await this.recordModelCall({
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      purpose: this.scenarioToPurpose(context.scenario),
      requestPrompt: this.serializeMessages(messages),
      responseText: fullContent,
      latencyMs: Date.now() - startTime,
    });

    return fullContent;
  }

  /**
   * 单次自然语言流式调用（不使用 thinking 模式 / reasoning_content / Structured Output）
   *
   * @param model 已配置 streaming 的模型实例
   * @param messages 消息列表
   * @param signal 中断信号
   * @param onToken 流式 token 回调（可空，仅用于实时转发）
   * @returns 完整文本
   */
  private async streamPlainChat(
    model: ChatOpenAI,
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
    onToken?: (token: string) => void,
  ): Promise<string> {
    let fullContent = '';
    const stream = await model.stream(messages, { signal });

    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw new Error('LLM generation aborted');
      }

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
    const startTime = Date.now();
    const modelName = context.player.modelName;

    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: true,
    });

    const history = await this.loadHistory(threadId);

    const thinkingPrompt = new HumanMessage(
      '你已明确自己的身份、阵营与队友（见系统提示）。请直接分析当前局势，输出你的思考过程，不要重复介绍身份或队友，不要任何前缀标记或 JSON。',
    );
    const thinkingMessages = [new SystemMessage(context.systemPrompt), ...history, thinkingPrompt];

    // 阶段1：流式输出思考
    const thinking = await this.streamPlainChat(model, thinkingMessages, signal, onThinking);

    // 记录思考调用
    await this.recordModelCall({
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      purpose: this.scenarioToPurpose(context.scenario),
      requestPrompt: this.serializeMessages(thinkingMessages),
      responseText: thinking,
      latencyMs: Date.now() - startTime,
    });

    const contentStartTime = Date.now();
    const contentPrompt = new HumanMessage(
      `你的思考过程如下：\n\n${thinking}\n\n请基于以上思考，输出你的发言内容。直接输出发言正文，不要重复自我介绍，不要任何前缀、标题、JSON 或额外解释。`,
    );
    const contentMessages = [new SystemMessage(context.systemPrompt), contentPrompt];

    // 阶段2：流式输出发言正文
    const content = await this.streamPlainChat(model, contentMessages, signal, onContent);

    // 记录正文调用
    await this.recordModelCall({
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      purpose: this.scenarioToPurpose(context.scenario),
      requestPrompt: this.serializeMessages(contentMessages),
      responseText: content,
      latencyMs: Date.now() - contentStartTime,
    });

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
    const startTime = Date.now();
    const modelName = context.player.modelName;
    const baseModel = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: false,
    });

    // 使用 withStructuredOutput 自动解析 JSON。
    // 采用 jsonMode（response_format=json_object）而非 functionCalling（tools + tool_choice）：
    // 火山方舟 plan v3 下并非所有模型都支持工具调用（deepseek-v4-pro / kimi-k3 会返回
    // 400 InvalidParameter），而 json_object 是所有模型都支持的基础能力。
    // jsonMode 不会把 schema 透传给模型，故由 Zod 派生 JSON Schema 注入 prompt；
    // 输出再用 Zod 硬校验（enum/required），失败则带错误上下文单次重试。
    const jsonSchema = z.toJSONSchema(zodSchema);
    const model = baseModel.withStructuredOutput(jsonSchema, { method: 'jsonMode' });

    const baseMessages: BaseMessage[] = [
      new SystemMessage(
        `${context.systemPrompt}\n\n## 决策任务\n请基于以上身份与规则，将 HumanMessage 中的推理过程严格转换为结构化输出，不要修改或优化推理结论。`,
      ),
      new HumanMessage(
        `推理过程：\n\n${reasoning}\n\n请严格按照以下 JSON Schema 输出决策，只输出 JSON，不要包含任何其他内容：\n${JSON.stringify(jsonSchema)}`,
      ),
    ];

    // 首次调用 + Zod 硬校验
    let decision: unknown = await model.invoke(baseMessages, { signal });
    const firstParse = zodSchema.safeParse(decision);

    // 校验失败：单次重试，把失败输出与错误原因反馈给模型
    if (!firstParse.success) {
      const issues = firstParse.error.issues.map((i) => i.message).join('；');
      this.logger.warn(`[决策校验] ${modelName} 输出未通过 Zod 校验，触发单次重试: ${issues}`);
      const retryMessages: BaseMessage[] = [
        ...baseMessages,
        new AIMessage(JSON.stringify(decision)),
        new HumanMessage(
          `你的输出未通过校验：${issues}\n请修正后重新输出，只输出符合 Schema 的 JSON。`,
        ),
      ];
      decision = zodSchema.parse(await model.invoke(retryMessages, { signal }));
    }

    await this.recordModelCall({
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      purpose: this.scenarioToPurpose(context.scenario),
      requestPrompt: this.serializeMessages(baseMessages),
      responseText: JSON.stringify(decision),
      latencyMs: Date.now() - startTime,
    });

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
    const visibilities: string[] = [VISIBILITY_TYPES.PUBLIC]; // 所有人都能看到 public

    const role = player.role;
    if (!role) {
      return visibilities;
    }

    switch (role) {
      case ROLES.SEER:
        visibilities.push(VISIBILITY_TYPES.SEER); // 预言家能看到预言家频道
        break;
      case ROLES.WITCH:
        visibilities.push(VISIBILITY_TYPES.WITCH); // 女巫能看到女巫频道

        // 女巫能看到狼人刀口信息（WOLF_KILL 频道），但需要满足条件
        // 条件：1. 女巫存活  2. 女巫未使用解药
        const isAlive = !player.deathDay; // deathDay 为 null 表示存活
        const hasUsedAntidote = events.some(
          (e) => e.actionType === ACTION_TYPES.WITCH_SAVE && e.actorId === player.id,
        );

        if (isAlive && !hasUsedAntidote) {
          visibilities.push(VISIBILITY_TYPES.WOLF_KILL); // 能看到狼人刀口
        }
        break;
      case ROLES.WEREWOLF:
        visibilities.push(VISIBILITY_TYPES.WOLF); // 狼人能看到狼人商议频道
        visibilities.push(VISIBILITY_TYPES.WOLF_KILL); // 狼人能看到刀口信息
        break;
      case ROLES.GUARD:
        visibilities.push(VISIBILITY_TYPES.GUARD); // 守卫能看到守卫频道
        break;
    }

    return visibilities;
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

    // 3. 查询 Memory
    const memories = await this.memoryService.retrieveActiveMemories(
      player.agentId,
      player.memoryLabelSnapshot,
    );

    // 4. 构建分层上下文
    const layeredContext = await this.buildLayeredContext({
      player,
      events,
    });

    // 5. 生成个性化发言摘要（所有场景）
    let speechSummary = '';
    const currentDay = await this.getCurrentRound(gameId, events);
    const alivePlayers = await this.prisma.player.findMany({
      where: {
        gameId,
        deathDay: null,
        id: { not: playerId }, // 排除自己
      },
      select: { seatNo: true },
    });
    const visiblePlayerSeats = alivePlayers
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

    // 6. 组装 System Prompt
    const systemPrompt = await this.assembleSystemPrompt({
      scenario,
      player,
      memories,
      context: layeredContext,
      additionalContext: [speechSummary, additionalContext].filter(Boolean).join('\n\n'),
    });

    return {
      systemPrompt,
      player,
      game: player.game,
      scenario,
    };
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
   * 步骤 1.2: Assemble System Prompt（组装 System Prompt）
   *
   * 渐进式披露架构：
   * - Prompts: 基础行为约束 + 场景指令
   * - Skills Layer 0: 核心决策框架（永远加载）
   * - Skills Layer 1: 狼人杀规则（根据板子加载）
   * - Skills Layer 2: 角色技能（根据身份加载）
   * - Skills Layer 3: 战术（根据场景按需加载）
   * - 人设 + 策略
   * - 角色特定历史
   * - 分层上下文
   */
  private async assembleSystemPrompt(options: {
    scenario: AgentScenario;
    player: PlayerWithGame;
    memories: ActiveMemory[];
    context: LayeredContext;
    additionalContext?: string;
  }): Promise<string> {
    const { scenario, player, memories, context, additionalContext } = options;

    // 获取游戏的技能版本
    const skillVersion = player.game.skillVersion || 'v1';

    // ===== Layer 0: 永远加载的核心内容 =====

    // 行为约束
    const constraintsSkill = await this.skillLoader.loadSkill('core/constraints', skillVersion);
    const constraints = constraintsSkill?.content || '';

    // 核心决策框架
    const frameworkSkill = await this.skillLoader.loadSkill('core/framework', skillVersion);
    const coreFramework = frameworkSkill?.content || '';

    // 基础规则
    const rulesSkill = await this.skillLoader.loadSkill('core/basic-rules', skillVersion);
    const basicRules = rulesSkill?.content || '';

    // 场景指令（根据当前 scenario 加载）
    const scenarioMap: Record<AgentScenario, string> = {
      [AGENT_SCENARIOS.NIGHT_ACTION]: 'scenarios/night-action',
      [AGENT_SCENARIOS.DAY_SPEECH]: 'scenarios/day-speech',
      [AGENT_SCENARIOS.VOTE]: 'scenarios/vote',
      [AGENT_SCENARIOS.LAST_WORDS]: 'scenarios/last-words',
      [AGENT_SCENARIOS.SHERIFF_DECIDE_ORDER]: 'scenarios/sheriff-decide-order',
    };
    const scenarioSkillId = scenarioMap[scenario];
    const scenarioSkill = await this.skillLoader.loadSkill(scenarioSkillId, skillVersion);
    const scenarioPrompt = scenarioSkill?.content || '';

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

    // ===== Layer 1+: 构建可按需加载的技能目录 =====

    // 构建 LoadContext 用于过滤技能目录
    const loadContext = {
      role: player.role,
      faction: player.faction,
      ruleset: player.game.rulesetId,
      scenario,
    };

    // 生成可按需加载的技能目录（Layer 1+）
    const skillCatalog = this.skillLoader.getCatalogMarkdown(loadContext);

    // 提取人设和策略记忆
    const personaMemory = memories.find((m) => m.type === 'persona');
    const strategyMemory = memories.find((m) => m.type === 'strategy');

    // 角色特定历史信息
    let roleSpecificInfo = '';

    // 预言家：查验历史
    if (player.role === ROLES.SEER) {
      const history = await this.getSeerCheckHistory(player.gameId, player.id);
      if (history) {
        roleSpecificInfo = `\n## 你的查验历史\n${history}\n`;
      }
    }

    // 组合完整 System Prompt（渐进式披露）
    const fullPrompt = `
      请使用中文进行思考和推理。所有输出（包括推理过程）必须使用中文。

      ${constraints}
      ${roleView}
      ${teammateInfo}
      ${scenarioPrompt}
      ${additionalContext ? `\n${additionalContext}\n` : ''}

      ## 核心决策框架
      ${coreFramework}

      ## 狼人杀基础规则
      ${basicRules}

      ## 可用技能目录
      ${skillCatalog}

      ## 你的人设
      ${personaMemory?.content || '暂无'}

      ## 你的策略
      ${strategyMemory?.content || '暂无'}
      ${roleSpecificInfo}

      ## 关键信息
      ${context.critical}

      ## 最近一轮详细
      ${context.recent}

      ## 历史摘要
      ${context.history}
    `.trim();

    return fullPrompt;
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
    if (!this.pool) {
      return [];
    }

    try {
      const history = new PostgresChatMessageHistory({
        sessionId: threadId,
        pool: this.pool,
      });
      return await history.getMessages();
    } catch {
      return [];
    }
  }

  /**
   * 保存会话历史
   */
  private async saveHistory(threadId: string, messages: BaseMessage[]): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      const history = new PostgresChatMessageHistory({
        sessionId: threadId,
        pool: this.pool,
      });

      // 滑动窗口：只保留最近 N 条消息，避免跨轮记忆无限增长
      const HISTORY_WINDOW = 20;
      const trimmed =
        messages.length > HISTORY_WINDOW
          ? messages.slice(messages.length - HISTORY_WINDOW)
          : messages;

      // 清空现有历史并添加新消息
      await history.clear();
      for (const message of trimmed) {
        await history.addMessage(message);
      }
    } catch (error) {
      this.logger.warn(
        `保存会话历史失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 记录一次 LLM 调用到 ModelCall 表（成本追踪、决策审计）
   *
   * 落库失败只告警、不阻断游戏流程。
   */
  private async recordModelCall(params: {
    gameId: string;
    playerId: string;
    modelName: string;
    purpose: string;
    requestPrompt: string;
    responseText: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    status?: 'success' | 'error' | 'timeout';
    errorMessage?: string;
  }): Promise<void> {
    try {
      await this.prisma.modelCall.create({
        data: {
          gameId: params.gameId,
          playerId: params.playerId,
          modelName: params.modelName,
          provider: 'ark',
          purpose: params.purpose,
          requestPrompt: params.requestPrompt,
          responseText: params.responseText,
          inputTokens: params.inputTokens ?? 0,
          outputTokens: params.outputTokens ?? 0,
          cost: 0,
          latencyMs: params.latencyMs,
          status: params.status ?? 'success',
          errorMessage: params.errorMessage,
        },
      });
    } catch (error) {
      this.logger.warn(
        `[ModelCall] 落库失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 场景 → ModelCall.purpose 映射
   */
  private scenarioToPurpose(scenario?: AgentScenario): string {
    switch (scenario) {
      case AGENT_SCENARIOS.NIGHT_ACTION:
        return PURPOSES.NIGHT_ACTION;
      case AGENT_SCENARIOS.DAY_SPEECH:
      case AGENT_SCENARIOS.LAST_WORDS:
        return PURPOSES.SPEECH;
      case AGENT_SCENARIOS.VOTE:
        return PURPOSES.VOTE;
      default:
        return PURPOSES.ANALYSIS;
    }
  }

  /**
   * 序列化消息列表为可读文本（用于 ModelCall.requestPrompt 落库）
   */
  private serializeMessages(messages: BaseMessage[]): string {
    return messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `[${m._getType()}]\n${content}`;
      })
      .join('\n\n');
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
   * Middleware: 构建行动摘要
   *
   * 从历史消息中提取所有 tool calls，生成人类可读的行动摘要
   */
  private async buildActionSummary(threadId: string): Promise<string> {
    const history = await this.loadHistory(threadId);

    const actions: string[] = [];

    for (const msg of history) {
      if (AIMessage.isInstance(msg)) {
        const aiMsg = msg as any;
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          for (const toolCall of aiMsg.tool_calls) {
            const summary = this.formatToolCallSummary(toolCall);
            if (summary) actions.push(summary);
          }
        }
      }
    }

    if (actions.length === 0) return '';

    const result = `## 你的历史行动\n${actions.join('\n')}`;
    return result;
  }

  /**
   * 格式化 tool call 为人类可读的摘要
   */
  private formatToolCallSummary(toolCall: any): string | null {
    const { name, args } = toolCall;

    switch (name) {
      case 'use_antidote':
        return `- 使用了解药救治 ${args.targetSeatNo}号位`;
      case 'use_poison':
        return `- 使用了毒药毒杀 ${args.targetSeatNo}号位`;
      case 'skip_action':
        return `- 选择不使用任何药物`;
      case 'propose_kill':
        return `- 提议刀 ${args.targetSeatNo}号位`;
      case 'check_identity':
        return `- 查验了 ${args.targetSeatNo}号位`;
      case 'cast_vote':
        return `- 投票给 ${args.targetSeatNo}号位`;
      case 'make_speech':
        // 发言内容太长，只记录动作
        return `- 发表了发言`;
      default:
        return null;
    }
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

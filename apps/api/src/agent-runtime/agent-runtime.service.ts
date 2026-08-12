import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, ToolMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, type ActiveMemory } from '../memory/memory.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { PromptLoaderService } from '../prompts/prompt-loader.service';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Env } from '../config/env.validation';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Prisma } from '../generated/prisma/client';
import { Pool } from 'pg';
import { getPlayerThreadId } from './thread-id.utils';
import {
  AGENT_SCENARIOS,
  FACTIONS,
  ROLES,
  VISIBILITY_TYPES,
  type AgentScenario,
} from '@ai-werewolf/shared';

type PlayerWithGame = Prisma.PlayerGetPayload<{
  include: { game: true };
}>;

type EventRecord = Prisma.EventGetPayload<Record<string, never>>;

/**
 * Agent 输入
 */
export interface AgentInput {
  gameId: string;
  playerId: string;
  scenario: AgentScenario;
  availableTools: StructuredToolInterface[];
  maxIterations?: number;
  threadId?: string; // 会话 ID，默认使用 gameId-playerId
  additionalContext?: string; // 额外的上下文信息（例如狼人投票时的讨论摘要）
  signal?: AbortSignal; // 用于中断 LLM 调用
}

/**
 * Agent 输出
 */
export interface AgentOutput {
  success: boolean;
  result?: any;
  error?: string;
  systemPrompt?: string;
  iterations?: number;
  thinking?: string; // AI 的推理过程（response.content）
}

/**
 * 分层上下文
 */
interface LayeredContext {
  critical: string; // 关键信息（当前状态）
  recent: string; // 最近一轮详细
  history: string; // 历史摘要
}

/**
 * Agent Runtime Service - 完整重构版本
 *
 * 实现 Phase 8 的完整设计：
 * 1. prepareContext - 准备上下文
 * 2. buildLayeredContext - 分层记忆
 * 3. assembleSystemPrompt - 组装 System Prompt（包含 Skill）
 * 4. reasonLoop - ReAct 循环 + 会话历史
 */
@Injectable()
export class AgentRuntimeService implements OnModuleInit, OnModuleDestroy {
  private checkpointSaver: PostgresSaver | null = null;
  private pool: Pool | null = null;

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly skillLoader: SkillLoaderService,
    private readonly promptLoader: PromptLoaderService,
  ) {}

  /**
   * 模块初始化时创建 PostgresSaver
   */
  async onModuleInit() {
    await this.initializeCheckpointSaver();
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
   * 初始化 PostgresSaver
   */
  private async initializeCheckpointSaver() {
    try {
      const databaseUrl = this.configService.get('DATABASE_URL');
      if (!databaseUrl) {
        return;
      }

      this.pool = new Pool({ connectionString: databaseUrl });

      this.checkpointSaver = new PostgresSaver(this.pool);
      await this.checkpointSaver.setup();
    } catch {
      this.checkpointSaver = null;
    }
  }

  /**
   * 运行 Agent Runtime
   *
   * 统一入口，处理所有场景
   */
  async run(input: AgentInput): Promise<AgentOutput> {
    const maxIterations = input.maxIterations ?? 5;
    const threadId = input.threadId ?? getPlayerThreadId(input.gameId, input.playerId);

    try {
      // 0. Middleware: 自动构建行动摘要
      const actionSummary = await this.buildActionSummary(threadId);

      // 1. Prepare Context（准备上下文）
      const context = await this.prepareContext({
        ...input,
        additionalContext: [actionSummary, input.additionalContext].filter(Boolean).join('\n\n'),
      });

      // 2-3. Reason & Execute Tool（推理 + 执行工具）
      const result = await this.reasonLoop(
        context,
        input.availableTools,
        maxIterations,
        threadId,
        input.signal,
      );

      return {
        success: true,
        result: result.finalResult,
        systemPrompt: context.systemPrompt,
        iterations: result.iterations,
        thinking: result.thinking,
      };
    } catch (error) {
      // 如果是 AbortError（AbortController 触发），重新抛出
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('aborted'))
      ) {
        throw error;
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        iterations: 0,
      };
    }
  }

  /**
   * 获取玩家可见的 visibility 列表
   *
   * 根据玩家角色返回该玩家有权看到的 Event visibility 类型
   *
   * @param role 玩家角色
   * @returns 可见的 visibility 列表
   */
  private getVisibleVisibilities(role: string | null): string[] {
    const visibilities: string[] = [VISIBILITY_TYPES.PUBLIC]; // 所有人都能看到 public

    if (!role) {
      return visibilities;
    }

    switch (role) {
      case ROLES.SEER:
        visibilities.push(VISIBILITY_TYPES.SEER); // 预言家能看到预言家频道
        break;
      case ROLES.WITCH:
        visibilities.push(VISIBILITY_TYPES.WITCH); // 女巫能看到女巫频道
        visibilities.push(VISIBILITY_TYPES.WOLF); // ⭐ 女巫需要看到狼人刀人信息（刀口）
        break;
      case ROLES.WEREWOLF:
        visibilities.push(VISIBILITY_TYPES.WOLF); // 狼人能看到狼人频道
        break;
      case ROLES.GUARD:
        visibilities.push(VISIBILITY_TYPES.GUARD); // 守卫能看到守卫频道
        break;
    }

    return visibilities;
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
  private async prepareContext(input: AgentInput): Promise<{
    systemPrompt: string;
    player: PlayerWithGame;
    game: Prisma.GameGetPayload<Record<string, never>>;
  }> {
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
    const visibleVisibilities = this.getVisibleVisibilities(player.role);
    const events = await this.prisma.event.findMany({
      where: {
        gameId,
        visibility: { in: visibleVisibilities }, // ⭐ 按 visibility 过滤
      },
      orderBy: { sequence: 'asc' },
    });

    // 3. 查询 Memory
    const memories = await this.memoryService.retrieveActiveMemories(
      player.agentId,
      player.memoryLabelSnapshot,
    );

    // 4. 构建分层上下文
    const layeredContext = await this.buildLayeredContext({
      player,
      events,
      scenario,
    });

    // 5. 组装 System Prompt
    const systemPrompt = await this.assembleSystemPrompt({
      scenario,
      player,
      memories,
      context: layeredContext,
      additionalContext, // 传递额外的上下文
    });

    return {
      systemPrompt,
      player,
      game: player.game,
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
    scenario: AgentScenario;
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
当前是第 ${currentDay} 天
存活玩家：${alivePlayers.map((p) => `${p.seatNo}号位(${p.displayName})`).join('、')}
    `.trim();

    // 2. 最近一轮详细：当天的所有事件
    const recentEvents = events.filter((e) => e.day === currentDay);
    const recent =
      recentEvents.length > 0
        ? recentEvents
            .map((e) => {
              const content = e.content as any;
              switch (e.actionType) {
                case 'wolf_kill':
                  return `- 狼人刀了 ${content.targetSeatNo}号位`;
                case 'seer_check':
                  return `- 预言家查验了 ${content.targetSeatNo}号位，结果：${content.result}`;
                case 'witch_action':
                  if (content.useAntidote)
                    return `- 女巫使用了解药救 ${content.antidoteTarget}号位`;
                  if (content.usePoison) return `- 女巫使用了毒药毒 ${content.poisonTarget}号位`;
                  return `- 女巫未使用药`;
                case 'player_speech':
                  return `- ${content.seatNo}号位发言：${content.speech || '(无)'}`;
                case 'player_vote':
                  return `- ${content.voterSeatNo}号位投票给 ${content.targetSeatNo}号位`;
                case 'death_announcement':
                  return `- 死亡公告：${content.deaths?.map((d: any) => `${d.seatNo}号位`).join('、')}`;
                default:
                  return `- ${e.actionType}`;
              }
            })
            .join('\n')
        : '暂无';

    // 3. 历史摘要：之前几天的关键事件
    const historyEvents = events.filter((e) => e.day && e.day < currentDay);
    const history =
      historyEvents.length > 0
        ? historyEvents
            .filter((e) =>
              ['wolf_kill', 'seer_check', 'death_announcement', 'exile'].includes(e.actionType),
            )
            .map((e) => {
              const content = e.content as any;
              const dayLabel = e.day ?? 0;
              switch (e.actionType) {
                case 'wolf_kill':
                  return `Day ${dayLabel}: 狼人刀了 ${content.targetSeatNo}号位`;
                case 'seer_check':
                  return `Day ${dayLabel}: 预言家查验 ${content.targetSeatNo}号位 → ${content.result}`;
                case 'death_announcement':
                  return `Day ${dayLabel}: 死亡 ${content.deaths?.map((d: any) => `${d.seatNo}号位`).join('、')}`;
                case 'exile':
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

    // ===== 从 Prompts 加载（行为约束 + 场景指令）=====
    const constraints = this.promptLoader.loadConstraints();
    const scenarioPrompt = this.promptLoader.loadScenarioPrompt(scenario);

    // 基础角色信息（只告诉玩家自己的身份）
    const roleView = `
      你是：${player.displayName}\n
      座位号：${player.seatNo}\n
      你的角色：${player.role}\n
      你的阵营：${player.faction === FACTIONS.WEREWOLF ? '狼人阵营' : '好人阵营'}\n
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

    // ===== 从 Skills 加载（决策框架 + 规则 + 角色 + 战术）=====

    // Skills Layer 0: 核心决策框架（永远加载）
    const coreFramework = await this.skillLoader.loadCoreFramework();

    // Skills Layer 1: 从文件加载规则 Skill（使用 game.skillVersion）
    const skillVersion = player.game.skillVersion || 'v1';
    const ruleSkill = await this.skillLoader.loadRuleSkill(skillVersion);

    // Skills Layer 2: 从文件加载角色 Skill
    if (!player.role) {
      throw new Error(`Player ${player.id} 没有分配角色`);
    }
    const roleSkill = await this.skillLoader.loadRoleSkill(player.role, skillVersion);

    // Skills Layer 3: 根据场景按需加载战术
    let tactics = '';
    if (scenario === AGENT_SCENARIOS.NIGHT_ACTION && player.role === ROLES.WEREWOLF) {
      // 狼人夜间行动：加载狼人战术（悍跳、倒钩）
      tactics = await this.skillLoader.loadTacticsByCategory('wolf', skillVersion);
    } else if (scenario === AGENT_SCENARIOS.DAY_SPEECH) {
      // 白天发言：根据阵营加载不同战术
      if (player.faction === FACTIONS.WEREWOLF) {
        // 狼人：加载狼人战术（悍跳、倒钩、自刀）
        tactics = await this.skillLoader.loadTacticsByCategory('wolf', skillVersion);
      } else {
        // 好人：加载反制战术（识别悍跳、识别倒钩）
        tactics = await this.skillLoader.loadTacticsByCategory('counter', skillVersion);
      }
    }

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

    // 女巫：刀口信息
    if (player.role === ROLES.WITCH && scenario === AGENT_SCENARIOS.NIGHT_ACTION) {
      const currentDay = await this.getCurrentRound(player.gameId, []);
      const wolfKillEvent = await this.prisma.event.findFirst({
        where: {
          gameId: player.gameId,
          actionType: 'wolf_kill',
          day: currentDay,
        },
        orderBy: { sequence: 'desc' },
      });

      if (wolfKillEvent) {
        const content = wolfKillEvent.content as any;
        const targetSeatNo = content.targetSeatNo;
        roleSpecificInfo += `\n## 今晚狼刀目标\n${targetSeatNo}号位被狼人刀中。\n`;
      }
    }

    // 组合完整 System Prompt（渐进式披露）
    const fullPrompt = `
${constraints}

${roleView}

${teammateInfo}

${scenarioPrompt}

${additionalContext ? `\n${additionalContext}\n` : ''}

## 核心决策框架
${coreFramework}

## 狼人杀规则
${ruleSkill}

## 你的角色技能
${roleSkill}

${tactics ? `## 战术库\n${tactics}\n` : ''}

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
        actionType: 'seer_check',
      },
      orderBy: { createdAt: 'asc' },
    });

    if (checkEvents.length === 0) {
      return '';
    }

    const history = checkEvents
      .map((e) => {
        const content = e.content as { targetSeatNo: number; result: string };
        const result = content.result === 'werewolf' ? '狼人' : '好人';
        return `  - ${content.targetSeatNo}号位：${result}`;
      })
      .join('\n');

    return `你已查验过以下玩家：\n${history}`;
  }

  /**
   * 步骤 2-3: Reason Loop（推理循环 + 工具执行）
   *
   * ReAct 循环 + 会话历史管理
   */
  private async reasonLoop(
    context: {
      systemPrompt: string;
      player: PlayerWithGame;
      game: Prisma.GameGetPayload<Record<string, never>>;
    },
    tools: StructuredToolInterface[],
    maxIterations: number,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<{ finalResult: unknown; iterations: number; thinking?: string }> {
    const model = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: this.configService.get('ARK_DEFAULT_MODEL'),
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
    }).bindTools(tools);

    // 加载会话历史
    const history = await this.loadHistory(threadId);

    // 构建消息列表
    const messages: BaseMessage[] = [
      new SystemMessage(context.systemPrompt),
      ...history,
      new HumanMessage('请基于当前信息做出决策。'),
    ];

    let finalResult: unknown = null;
    let thinking: string | undefined;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const response = await model.invoke(messages, { signal });
      messages.push(response);

      // 捕获推理内容
      if (typeof response.content === 'string' && response.content.trim()) {
        thinking = response.content;
      }

      const toolCalls = response.tool_calls ?? [];
      if (toolCalls.length === 0) {
        if (iteration === maxIterations - 1) {
          throw new Error('超出迭代上限，未产出决策');
        }
        continue;
      }

      // 执行工具
      for (const toolCall of toolCalls) {
        const tool = tools.find((t) => t.name === toolCall.name);
        if (!tool) {
          throw new Error(`工具 ${toolCall.name} 未注册`);
        }

        try {
          const toolResult = await tool.invoke(toolCall.args ?? {});
          messages.push(
            new ToolMessage({
              content: JSON.stringify(toolResult),
              tool_call_id: toolCall.id!,
            }),
          );

          finalResult = toolResult;
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          messages.push(
            new ToolMessage({
              content: JSON.stringify({ error: errorMsg }),
              tool_call_id: toolCall.id!,
            }),
          );
        }
      }

      // 所有工具执行完毕后，如果有成功的结果，保存历史并返回
      if (finalResult !== null) {
        await this.saveHistory(threadId, messages.slice(1));
        return { finalResult, iterations: iteration + 1, thinking };
      }
    }

    throw new Error('超出迭代上限，未产出有效决策');
  }

  /**
   * 加载会话历史
   */
  private async loadHistory(threadId: string): Promise<BaseMessage[]> {
    if (!this.checkpointSaver) {
      return [];
    }

    try {
      // 使用 getTuple 获取完整的 checkpoint
      const tuple = await this.checkpointSaver.getTuple({
        configurable: { thread_id: threadId },
      });

      if (!tuple || !tuple.checkpoint) {
        return [];
      }

      const messages = (tuple.checkpoint.channel_values as any)?.messages || [];
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * 保存会话历史
   */
  private async saveHistory(threadId: string, messages: BaseMessage[]): Promise<void> {
    if (!this.checkpointSaver) {
      return;
    }

    try {
      const config = { configurable: { thread_id: threadId } };

      // 获取当前 checkpoint（如果存在）
      const currentTuple = await this.checkpointSaver.getTuple(config);

      const checkpoint = {
        v: 1,
        ts: new Date().toISOString(),
        id: threadId,
        channel_values: { messages },
        channel_versions: currentTuple?.checkpoint?.channel_versions || {},
        versions_seen: currentTuple?.checkpoint?.versions_seen || {},
      };

      const metadata = {
        source: 'update' as const,
        step: (currentTuple?.metadata?.step || -1) + 1,
        writes: null,
        parents: currentTuple?.metadata?.parents || {},
      };

      await this.checkpointSaver.put(
        config,
        checkpoint,
        metadata,
        {}, // newVersions
      );
    } catch {
      //
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
}

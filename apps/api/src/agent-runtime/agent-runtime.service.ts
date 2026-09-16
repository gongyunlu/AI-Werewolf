import { Injectable, Logger, Optional } from '@nestjs/common';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService, type ActiveMemory, type SimilarMemory } from '../memory/memory.service';
import { GlobalMemoryService, type ActivePattern } from '../memory/global-memory.service';
import { KnowledgeService, type KnowledgeHit } from '../knowledge/knowledge.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import type { ModelCallMode } from '../llm/model-call-guard';
import { throwIfAborted } from '../llm/abort.utils';
import { ModelCallService, type ModelAccess } from '../llm/model-call.service';
import { PlayerTurnService } from '../player-turn/player-turn.service';
import { resolvePlayerAccess } from '../agents/agent-access';
import { PromptService } from '../observability/prompt.service';
import type { ActionSource } from '../observability/action-source';
import { submissionKey } from '../game-engine/events/submission-protocol';
import { PROMPT_NAMES, PLAYER_TURN_PROMPT_NAMES } from '../observability/prompt-templates';
import type { Env } from '../config/env.validation';
import { Prisma } from '../generated/prisma/client';
import {
  getHistoricallyVisibleEvents,
  getVisibleVisibilitiesForRole,
} from '../game-engine/rules/visibility';
import {
  ACTION_TYPES,
  AGENT_SCENARIOS,
  FACTIONS,
  ROLES,
  type AgentScenario,
} from '@ai-werewolf/shared';
import { buildTurnContext, ownThinkingFromEvent, type TurnContextRequest } from './turn-context';
import { formatMemorySection } from './memory-prompt.utils';
import { buildScenarioQuery } from './scenario-query';
import {
  readExperiment,
  type ExperimentSnapshot,
  type FrozenPrompts,
} from '../evaluation/experiment-snapshot';
import { buildKnowledgeFacts } from '../knowledge/knowledge-policy';
import {
  assertExperimentConfiguration,
  ExperimentInvalidError,
} from '../evaluation/experiment-integrity';

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

/**
 * Agent 上下文（prepareContext 的产物，贯穿决策与发言）
 */
interface AgentContext {
  actionKey?: string;
  source?: ActionSource;
  experiment?: ExperimentSnapshot;
  prompts?: FrozenPrompts;
  retrievalId?: string;
  replay?: Record<string, unknown>;
  systemPrompt: string;
  player: PlayerWithGame;
  game: Prisma.GameGetPayload<Record<string, never>>;
  /** 当前场景 */
  scenario: AgentScenario;
  /** 该玩家在本局固定使用的接入端点；缺省时用环境变量默认接入。密钥不写入任何快照或追踪。 */
  access?: ModelAccess;
  /** 已注入 Prompt、待行为 Event 成功落库后确认的记忆使用关系 */
  pendingMemoryUsages: Array<{ memoryId: string; triggerMatched: boolean }>;
  /** 已注入 Prompt、待行为 Event 成功落库后确认的攻略使用关系 */
  pendingKnowledgeUsages: Array<{ chunkId: string }>;
}

/**
 * Agent Runtime Service - 上下文准备、发言与决策
 *
 * 1. prepareContext - 准备上下文
 * 3. assembleSystemPrompt - 组装 System Prompt（包含 Skill）
 * 4. decide - 同次生成理由与结构化动作
 */
@Injectable()
export class AgentRuntimeService {
  private readonly logger = new Logger(AgentRuntimeService.name);

  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly memoryService: MemoryService,
    private readonly globalMemoryService: GlobalMemoryService,
    private readonly knowledgeService: KnowledgeService,
    private readonly skillLoader: SkillLoaderService,
    private readonly speechSummarizer: SpeechSummarizerService,
    private readonly promptService: PromptService,
    private readonly modelCalls: ModelCallService,
    private readonly playerTurn: PlayerTurnService,
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {}

  runModelCall<T>(
    modelName: string,
    call: (signal: AbortSignal, reportProgress: () => void) => Promise<T>,
    signal?: AbortSignal,
    diagnostics?: Record<string, unknown>,
    mode: ModelCallMode = 'invoke',
  ): Promise<T> {
    return this.modelCalls.run(modelName, call, signal, diagnostics, mode);
  }

  /**
   * 发言类场景：流式输出「思考」与「正文」
   *
   * 两段自然语言流式调用，均以 content 字段流式输出（不使用 reasoning_content、
   * Structured Output 或工具调用），满足「后端直接转发 LLM 真实流」的需求。
   *
   * @param context 已准备好的上下文
   * @param options.onThinking 思考 token 回调
   * @param options.onContent 正文 token 回调
   * @returns 思考与正文完整文本
   */
  async streamSpeech(
    context: AgentContext,
    options: {
      signal?: AbortSignal;
      onThinking?: (token: string) => void;
      onContent?: (token: string) => void;
      reflectionMaxRounds?: number;
    } = {},
  ): Promise<{
    thinking: string;
    content: string;
    thinkingDurationMs: number;
    contentDurationMs: number;
  }> {
    let generated = false;
    const saved = await this.durable(`speech/${context.player.id}`, async () => {
      generated = true;
      return {
        result: await this.playerTurn.speech(context, options),
        replay: context.replay,
        source: context.source,
      };
    });
    throwIfAborted(options.signal);
    context.replay = saved.replay;
    context.source = saved.source;
    if (!generated) {
      options.onThinking?.(saved.result.thinking);
      options.onContent?.(saved.result.content);
    }
    return saved.result;
  }

  /** 在同一次模型调用中形成理由与动作，不再二次转换推理结论。 */
  async decide<T = any>(
    context: AgentContext,
    zodSchema: z.ZodType,
    signal?: AbortSignal,
    options: {
      /** 覆盖本局的反思轮次；狼队夜间自身的迭代已经足够，不需要再叠加。 */
      reflectionMaxRounds?: number;
    } = {},
  ): Promise<{ reasoning: string; decision: T }> {
    const saved = await this.durable(`decision/${context.player.id}`, async () => ({
      result: await this.playerTurn.decide<T>(context, zodSchema, signal, options),
      replay: context.replay,
      source: context.source,
    }));
    context.replay = saved.replay;
    context.source = saved.source;
    throwIfAborted(signal);
    return saved.result;
  }

  /**
   * 在当前执行 scope 内物化整份输入，恢复时复用原文与版本。
   *
   * 接入密钥在检查点之外补挂：上下文整体会被序列化进恢复日志，密钥一旦进去就是明文落库，
   * 恢复时还会把当时的旧 key 读回来用。端点则允许进检查点，续跑用的端点和原来一致。
   */
  async prepareContextPublic(input: TurnContextRequest): Promise<AgentContext> {
    const context = await this.durable(`context/${input.playerId}`, () =>
      this.prepareContext(input),
    );
    return {
      ...context,
      access: await resolvePlayerAccess(
        this.prisma,
        this.configService.get('AGENT_SECRET_KEY'),
        context.player,
        {
          baseUrl: this.configService.get('ARK_BASE_URL'),
          apiKey: this.configService.get('ARK_API_KEY'),
        },
      ),
    };
  }

  /** 普通投票全员共享水位；恢复时沿用节点已冻结的截止序号。 */
  async voteVisibleThrough(gameId: string): Promise<number> {
    if (this.recovery?.current?.visibleThrough !== undefined)
      return this.recovery.current.visibleThrough;
    const event = await this.prisma.event.findFirst({
      where: { gameId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    return event?.sequence ?? 0;
  }

  /**
   * 行为 Event 成功写入后确认本次真正使用的经验。
   *
   * 同一个 Event 可能因节点/队列重试重复确认，数据库的 (memoryId, eventId) 唯一约束负责幂等。
   * actor/game 不匹配说明调用方把上下文绑到了别人的事件上，宁可丢弃观测数据也不能错记 reward。
   */
  async recordExperienceUsages(
    context: AgentContext,
    event: Pick<EventRecord, 'id' | 'gameId' | 'actorId' | 'actionType' | 'day'> &
      Partial<Pick<EventRecord, 'source'>>,
  ): Promise<void> {
    return this.durable(`experience/${event.actorId}`, () =>
      this.persistExperienceUsages(context, event),
    );
  }

  private async persistExperienceUsages(
    context: AgentContext,
    event: Pick<EventRecord, 'id' | 'gameId' | 'actorId' | 'actionType' | 'day'> &
      Partial<Pick<EventRecord, 'source'>>,
  ): Promise<void> {
    // 重复提交会命中首次写入的 Event，其采用的模型调用可能不是本次上下文这一轮
    // （节点重试、跨执行重放都会重新调用模型）。两者的注入不是同一批，不能拿本次的待确认项去记原行动的账。
    const committed = event.source as unknown as ActionSource | null | undefined;
    const adopted = context.source;
    if (
      committed &&
      (committed.actionKey !== adopted?.actionKey ||
        committed.attemptId !== adopted?.attemptId ||
        committed.outputObservationId !== adopted?.outputObservationId)
    ) {
      this.logger.warn(
        {
          eventId: event.id,
          committedAttemptId: committed.attemptId,
          contextAttemptId: adopted?.attemptId,
        },
        '该 Event 采用的是另一次模型调用，跳过本次注入的确认',
      );
      return;
    }
    // memory 与 knowledge 任一注入待确认都应继续走到下方各自记录
    if (
      !context.replay &&
      context.pendingMemoryUsages.length === 0 &&
      context.pendingKnowledgeUsages.length === 0
    ) {
      return;
    }
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

    if (context.replay) {
      try {
        await this.prisma.decisionContext.upsert({
          where: { eventId: event.id },
          update: {},
          create: {
            eventId: event.id,
            gameId: event.gameId,
            playerId: context.player.id,
            snapshot: JSON.parse(JSON.stringify(context.replay)) as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        this.logger.error(
          { eventId: event.id, err: error instanceof Error ? error.message : String(error) },
          '决策快照保存失败，该事件不可用于受控重放',
        );
        if (context.experiment)
          throw new ExperimentInvalidError('实验决策输入快照保存失败', { cause: error });
      }
    }
    if (context.retrievalId) {
      try {
        await this.prisma.knowledgeRetrieval.updateMany({
          where: { id: context.retrievalId, eventId: null },
          data: { eventId: event.id },
        });
      } catch (error) {
        this.logger.warn(
          { eventId: event.id, err: error instanceof Error ? error.message : String(error) },
          '检索日志关联失败',
        );
      }
    }
    // 实验使用证据保存在快照，避免实验行为改变普通对局的记忆热度和排序。
    if (!context.experiment)
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

    // 攻略注入同样延迟到行为 Event 落库后确认，保证只记真实生效的注入
    if (context.pendingKnowledgeUsages.length > 0) {
      await this.knowledgeService.recordUsages(
        context.pendingKnowledgeUsages.map((usage) => ({
          chunkId: usage.chunkId,
          eventId: event.id,
          gameId: event.gameId,
          playerId: context.player.id,
          scenario: context.scenario,
          actionType: event.actionType,
          day: event.day!,
        })),
      );
    }
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
   * 4. 按引擎时点组装授权事件与主观判断
   * 5. 组装 System Prompt
   */
  private async prepareContext(input: TurnContextRequest): Promise<AgentContext> {
    const { gameId, playerId, scenario, additionalContext, position, actionType } = input;
    const currentDay = position.day;
    const visibleThrough = input.visibleThrough ?? this.recovery?.current?.visibleThrough;
    const eventCutoff = visibleThrough === undefined ? {} : { sequence: { lte: visibleThrough } };

    // 1. 查询 Player + Game
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player || player.gameId !== gameId) {
      throw new Error('玩家不存在或不属于该对局');
    }
    const experiment = readExperiment(player.game.experiment);
    if (experiment)
      assertExperimentConfiguration(experiment, this.configService.get('ARK_EMBEDDING_MODEL'));

    // 先限制角色可读的事件类型，再按观察时点投影历史权限。
    const candidateVisibilities = getVisibleVisibilitiesForRole({
      role: player.role,
      isAlive: true,
      hasUsedAntidote: false,
    });
    let events = getHistoricallyVisibleEvents(
      player,
      await this.prisma.event.findMany({
        where: { gameId, visibility: { in: candidateVisibilities }, ...eventCutoff },
        orderBy: { sequence: 'asc' },
      }),
    );

    // 投票是并发同时执行：决策时点不应看到本轮其他人的投票，保留已经结束的投票轮次
    if (scenario === AGENT_SCENARIOS.VOTE) {
      events = events.filter(
        (e) =>
          !(
            e.actionType === ACTION_TYPES.VOTE &&
            e.day === currentDay &&
            Number((e.content as Record<string, unknown>).voteRound ?? 0) >= position.round
          ),
      );
    }

    // 3. 查询 Memory
    let memories = experiment
      ? []
      : await this.memoryService.retrieveActiveMemories(
          player.agentId,
          player.memoryLabelSnapshot,
          { types: ['persona', 'strategy'] },
        );

    // 3.1 检索历史经验（独立于 persona/strategy，见 MemoryService.retrieveExperience）
    const opponents = await this.prisma.player.findMany({
      where: { gameId, id: { not: playerId } },
      select: { agentId: true, seatNo: true, displayName: true },
    });
    const query = `${buildScenarioQuery({ role: player.role, scenario, day: currentDay, events })}\n板子：${player.game.rulesetId}\n动作：${actionType}\n${additionalContext ?? ''}`;
    const situation = {
      rulesetId: player.game.rulesetId,
      actionType,
      facts: buildKnowledgeFacts({
        day: currentDay,
        role: player.role,
        playerId,
        seatNo: player.seatNo,
        events,
      }),
    };
    const experienceInput = {
      agentId: player.agentId,
      label: player.memoryLabelSnapshot,
      opponentAgentIds: opponents.map((o) => o.agentId),
      query,
      facts: situation.facts,
      role: player.role,
      scenario,
    };
    const frozen = experiment
      ? await this.memoryService.retrieveFrozen(experiment, experienceInput).catch((error) => {
          throw new ExperimentInvalidError('实验冻结记忆检索失败', { cause: error });
        })
      : undefined;
    const experience = frozen ?? (await this.memoryService.retrieveExperience(experienceInput));
    if (frozen) memories = frozen.active;
    const pendingMemoryUsages = this.buildPendingMemoryUsages(experience);

    // 全局板子规律：跨对局晋升验证，与身份无关，全量注入所有玩家
    const globalPatterns =
      experiment?.globalPatterns ?? (await this.globalMemoryService.retrieveActivePatterns());

    // 攻略知识库：外部静态战术。普通局允许检索降级，冻结实验在检索失效时中止。
    // KNOWLEDGE_INJECTION 关闭时跳过检索（A/B 对照实验），返回空攻略。
    let retrievalId: string | undefined;
    const injectionEnabled = experiment
      ? experiment.arm === 'on'
      : this.configService.get('KNOWLEDGE_INJECTION', { infer: true });
    const knowledgeHits = injectionEnabled
      ? await this.knowledgeService
          .retrieve(query, player.role, scenario, {
            situation,
            gameId,
            playerId,
            chunkIds: experiment?.knowledgeChunkIds,
            strict: Boolean(experiment),
            onAudit: (id) => {
              retrievalId = id;
            },
          })
          .catch((error) => {
            if (experiment) throw new ExperimentInvalidError('实验攻略检索失败', { cause: error });
            throw error;
          })
      : [];

    // 主观判断独立标注，已提交原文和行动只由 events 提供。
    const personalJudgments = await this.speechSummarizer.readPersonalJudgments(
      gameId,
      currentDay,
      player.agentId,
    );

    // 6. 组装 System Prompt
    const prompts =
      experiment?.prompts ??
      this.recovery?.current?.manifest.prompts ??
      (await this.promptService.captureGameSnapshot(gameId, PLAYER_TURN_PROMPT_NAMES));
    const turnContext = buildTurnContext({
      playerId,
      seatNo: player.seatNo,
      roster: [player, ...opponents],
      actionType,
      events,
      position,
      ownReasonings: await this.loadOwnReasonings(gameId, playerId, events),
    });
    const assembly = {
      turnContext,
      prompts,
      scenario,
      player,
      memories,
      experience,
      globalPatterns,
      knowledgeHits,
      additionalContext: [this.formatPersonalJudgments(personalJudgments), additionalContext]
        .filter(Boolean)
        .join('\n\n'),
    };
    const systemPrompt = await this.assembleSystemPrompt(assembly);
    const baseSystemPrompt = knowledgeHits.length
      ? await this.assembleSystemPrompt({ ...assembly, knowledgeHits: [] })
      : systemPrompt;

    return {
      systemPrompt,
      ...(input.phaseInstanceId
        ? {
            actionKey: submissionKey(
              { gameId, phaseInstanceId: input.phaseInstanceId },
              actionType,
              playerId,
              input.actionOrdinal ?? 0,
            ),
          }
        : {}),
      experiment,
      prompts,
      retrievalId,
      replay: {
        version: 1,
        baseSystemPrompt,
        systemPrompt,
        modelName: player.modelName,
        role: player.role,
        scenario,
        query,
        situation,
        turnContext,
        position,
        knowledgeHits,
        injectionEnabled: Boolean(injectionEnabled),
        evidence: events,
        memoryIds: [...memories, ...experience.lessons, ...experience.playerModels].map(
          (m) => m.id,
        ),
        prompts,
      },
      player,
      game: player.game,
      scenario,
      pendingMemoryUsages,
      pendingKnowledgeUsages: knowledgeHits.map((hit) => ({ chunkId: hit.id })),
    };
  }

  /**
   * 本人历史动作的私有理由：先取事件里已提交的 thinking，缺失的（如投票不写 thinking）
   * 再按 game/player/event 批量回读决策快照的最终 reasoning。
   *
   * 只读 reasoning 一个字段，不复制旧 Prompt、证据或别人的 thinking；旧事件缺字段时不补造。
   */
  private async loadOwnReasonings(
    gameId: string,
    playerId: string,
    events: EventRecord[],
  ): Promise<Map<string, string>> {
    const reasonings = new Map<string, string>();
    const missing: string[] = [];
    for (const event of events) {
      if (event.actorId !== playerId) continue;
      const thinking = ownThinkingFromEvent(event, playerId);
      if (thinking) reasonings.set(event.id, thinking);
      else missing.push(event.id);
    }
    if (missing.length === 0) return reasonings;

    const snapshots = await this.prisma.decisionContext.findMany({
      where: { gameId, playerId, eventId: { in: missing } },
      select: { eventId: true, snapshot: true },
    });
    for (const { eventId, snapshot } of snapshots) {
      const reasoning = (snapshot as { reasoning?: unknown } | null)?.reasoning;
      if (typeof reasoning === 'string' && reasoning.trim()) reasonings.set(eventId, reasoning);
    }
    return reasonings;
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
   * 步骤 1.2: Assemble System Prompt（组装 System Prompt）
   *
   * 组装结构（骨架走 PromptService 模板，动态内容按变量注入）：
   * - 行为约束 / 核心决策框架 / 基础规则：内联在模板正文
   * - 板子规则：按 rulesetId 加载（rulesets/standard6p）
   * - 场景指令：按 scenario 加载（scenarios/day-speech 等）
   * - 角色玩法：按 player.role 加载（roles/werewolf 等）
   * - 人设 + 策略：从 memories 提取
   * - 引擎时点、授权事件原文与主观历史判断
   */
  private async assembleSystemPrompt(options: {
    prompts?: FrozenPrompts;
    scenario: AgentScenario;
    player: PlayerWithGame;
    memories: ActiveMemory[];
    experience: { lessons: ActiveMemory[]; playerModels: ActiveMemory[] };
    globalPatterns: Pick<ActivePattern, 'title' | 'content'>[];
    turnContext?: string;
    knowledgeHits: KnowledgeHit[];
    additionalContext?: string;
  }): Promise<string> {
    const {
      scenario,
      player,
      memories,
      experience,
      globalPatterns,
      knowledgeHits,
      additionalContext,
    } = options;

    // 获取游戏的技能版本
    const skillVersion = player.game.skillVersion || 'v1';
    const experiment = readExperiment(player.game.experiment);
    const loadSkill = async (id: string) => {
      if (!experiment) return this.skillLoader.loadRequiredSkill(id, skillVersion);
      const content = experiment.skills[id];
      if (content === undefined) throw new ExperimentInvalidError(`实验快照缺少 skill: ${id}`);
      return { content };
    };

    // 当前板子规则（按 rulesetId 加载，例如 rulesets/standard6p）
    const rulesetSkill = await loadSkill(`rulesets/${player.game.rulesetId}`);
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
    const scenarioSkill = await loadSkill(scenarioSkillId);
    const scenarioPrompt = scenarioSkill.content;

    // 角色玩法正文（按 player.role 条件加载，例如 roles/werewolf）
    const roleSkill = await loadSkill(`roles/${player.role}`);
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

    // 攻略知识库：外部静态战术条目，按当前局面命中注入。附「与本局冲突以本局为准」防误导。
    const knowledgeSection =
      knowledgeHits.length > 0
        ? knowledgeHits
            .map(
              (hit) =>
                `### ${hit.articleTitle}【${hit.role === 'any' ? '通用' : hit.role}】\n场景：${hit.scenario}\n触发：${hit.trigger}\n行动：${hit.action}`,
            )
            .join('\n\n')
        : '';

    // 组合完整 System Prompt（渐进式披露），骨架模板走 PromptService 便于在线调整
    const fullPrompt = await this.promptService.render(
      PROMPT_NAMES.agentSystemPrompt,
      {
        turnContext: options.turnContext ?? '',
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
        knowledge: knowledgeSection || '暂无',
      },
      options.prompts ?? experiment?.prompts,
    );

    return fullPrompt.text;
  }

  private durable<T>(key: string, produce: () => Promise<T>): Promise<T> {
    return this.recovery ? this.recovery.value(key, produce) : produce();
  }

  /**
   * 格式化个人历史判断（主观意见，不替代事件事实）
   */
  private formatPersonalJudgments(summary: {
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

    // 我的分析（近2天）
    if (summary.recentJudgments.length > 0) {
      parts.push(`\n## 我的历史分析（近2天的主观判断，可随新信息调整）`);
      for (const j of summary.recentJudgments) {
        parts.push(
          `- ${j.speaker}号位：信任度${j.trustScore}%${j.suspicious ? '（可疑）' : ''} - ${j.notes}`,
        );
      }
    }

    // 我的历史分析（2天以前摘要）
    if (summary.olderJudgmentsSummary.length > 0) {
      parts.push(`\n## 我的历史分析（更早的主观判断摘要，可随新信息调整）`);
      for (const j of summary.olderJudgmentsSummary) {
        parts.push(`- ${j.seatNo}号位：最新信任度${j.latestTrustScore}% - ${j.notes}`);
      }
    }

    return parts.join('\n');
  }
}

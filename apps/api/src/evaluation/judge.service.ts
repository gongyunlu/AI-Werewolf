import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';
import { LangfuseService } from '../observability/langfuse.service';
import { PromptService } from '../observability/prompt.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { ACTION_TYPES, FACTIONS } from '@ai-werewolf/shared';
import type { Env } from '../config/env.validation';
import { JudgeOutputSchema, type JudgeOutput } from './judge-schema';
import { buildJudgePromptVariables, type JudgeEventInput } from './judge-prompt';

/** 可评估的决策事件：查验/用药/投票（saved/used=false 的「不用药」不算决策） */
export function isJudgeableAction(actionType: string, content: Record<string, unknown>): boolean {
  switch (actionType) {
    case ACTION_TYPES.SEER_CHECK:
      return true;
    case ACTION_TYPES.WITCH_SAVE:
      return content.saved === true;
    case ACTION_TYPES.WITCH_POISON:
      return content.used === true;
    case ACTION_TYPES.VOTE:
      return typeof content.targetSeatNo === 'number' && content.targetSeatNo > 0;
    default:
      return false;
  }
}

/**
 * LLM-as-judge 决策质量评估服务。
 *
 * 对单个决策事件做「决策时点视角还原」，调用 judge 模型打分并落 DecisionJudgment。
 */
@Injectable()
export class JudgeService {
  private readonly logger = new Logger(JudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService<Env, true>,
    private readonly langfuse: LangfuseService,
    private readonly promptService: PromptService,
  ) {}

  /** 找出对局内所有可评估的决策事件 id */
  async findJudgeableEvents(gameId: string): Promise<string[]> {
    const events = await this.prisma.event.findMany({
      where: { gameId },
      select: { id: true, actionType: true, content: true },
      orderBy: { sequence: 'asc' },
    });

    return events
      .filter((e) => isJudgeableAction(e.actionType, (e.content as Record<string, unknown>) ?? {}))
      .map((e) => e.id);
  }

  /** 评估单个决策事件并落库 */
  async judgeEvent(gameId: string, eventId: string): Promise<void> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        gameId: true,
        sequence: true,
        day: true,
        actionType: true,
        visibility: true,
        actorId: true,
        content: true,
      },
    });

    if (!event || event.gameId !== gameId) {
      this.logger.warn({ gameId, eventId }, '决策事件不存在或不属于该对局，跳过评估');
      return;
    }

    const content = (event.content as Record<string, unknown>) ?? {};
    if (!isJudgeableAction(event.actionType, content)) {
      return;
    }
    if (!event.actorId) {
      this.logger.warn({ gameId, eventId }, '决策事件缺少 actorId，跳过评估');
      return;
    }

    const player = await this.prisma.player.findUnique({
      where: { id: event.actorId },
      select: { id: true, seatNo: true, role: true, faction: true, deathDay: true },
    });
    if (!player) {
      this.logger.warn({ gameId, eventId, actorId: event.actorId }, '决策玩家不存在，跳过评估');
      return;
    }

    // 队友：仅狼人阵营互通身份
    let teammates: number[] = [];
    if (player.faction === FACTIONS.WEREWOLF) {
      const wolves = await this.prisma.player.findMany({
        where: { gameId, faction: FACTIONS.WEREWOLF, id: { not: player.id } },
        select: { seatNo: true },
      });
      teammates = wolves.map((w) => w.seatNo).filter((s): s is number => s !== null);
    }

    // 只取决策时点之前的事件：buildJudgePromptVariables 内部本就按 sequence < decision.sequence 过滤，
    // 决策之后的事件对评估无意义，SQL 层下推减少返回行数
    const allEvents = await this.prisma.event.findMany({
      where: { gameId, sequence: { lt: event.sequence } },
      select: {
        sequence: true,
        day: true,
        actionType: true,
        visibility: true,
        actorId: true,
        content: true,
      },
      orderBy: { sequence: 'asc' },
    });

    const judgeEvents: JudgeEventInput[] = allEvents.map((e) => ({
      sequence: e.sequence,
      day: e.day,
      actionType: e.actionType,
      visibility: e.visibility,
      actorId: e.actorId,
      content: (e.content as Record<string, unknown>) ?? {},
    }));

    const variables = buildJudgePromptVariables({
      playerId: player.id,
      playerSeatNo: player.seatNo,
      playerRole: player.role ?? '',
      playerFaction: player.faction ?? '',
      isAlive: player.deathDay === null || (event.day ?? 0) <= player.deathDay,
      teammates,
      decision: {
        sequence: event.sequence,
        actionType: event.actionType,
        day: event.day ?? 0,
        targetSeatNo: typeof content.targetSeatNo === 'number' ? content.targetSeatNo : null,
        thinking: typeof content.thinking === 'string' ? content.thinking : undefined,
      },
      events: judgeEvents,
    });

    const [systemPrompt, userPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.judgeSystem),
      this.promptService.render(PROMPT_NAMES.judgeUser, variables),
    ]);

    const { verdict, score, reasoning, modelName } = await this.invokeJudge(
      systemPrompt.text,
      userPrompt.text,
      gameId,
      player.id,
      player.seatNo,
      player.role,
      userPrompt.name,
      userPrompt.version,
    );

    await this.prisma.decisionJudgment.upsert({
      where: { eventId },
      update: { verdict, score, reasoning, modelName },
      create: {
        gameId,
        playerId: player.id,
        eventId,
        actionType: event.actionType,
        day: event.day ?? 0,
        targetSeatNo: typeof content.targetSeatNo === 'number' ? content.targetSeatNo : null,
        verdict,
        score,
        reasoning,
        modelName,
      },
    });

    this.logger.log(
      { gameId, eventId, actionType: event.actionType, verdict, score },
      '决策评估完成',
    );
  }

  /** 调用 judge 模型 + LangFuse 追踪 + Zod 校验（失败单次重试） */
  private async invokeJudge(
    system: string,
    user: string,
    gameId: string,
    playerId: string,
    seatNo: number | null,
    role: string | null,
    promptName: string,
    promptVersion: number | null,
  ): Promise<JudgeOutput & { modelName: string }> {
    const modelName =
      this.configService.get('JUDGE_MODEL') ?? this.configService.get('ARK_DEFAULT_MODEL');
    const baseModel = new ChatOpenAI({
      apiKey: this.configService.get('ARK_API_KEY'),
      model: modelName,
      configuration: { baseURL: this.configService.get('ARK_BASE_URL') },
      streaming: false,
    });

    const jsonSchema = z.toJSONSchema(JudgeOutputSchema);
    const model = baseModel.withStructuredOutput(jsonSchema, { method: 'jsonMode' });

    const baseMessages: BaseMessage[] = [
      new SystemMessage(system),
      new HumanMessage(
        `${user}\n\n请严格按以下 JSON Schema 输出评估结果：\n${JSON.stringify(jsonSchema)}`,
      ),
    ];

    let output: unknown = await model.invoke(baseMessages, {
      ...this.langfuse.trace({
        runName: 'judge',
        gameId,
        playerId,
        modelName,
        scenario: 'judge',
        seatNo,
        role,
        promptName,
        promptVersion,
      }),
    });

    const firstParse = JudgeOutputSchema.safeParse(output);
    if (!firstParse.success) {
      const issues = firstParse.error.issues.map((i) => i.message).join('；');
      this.logger.warn(`[judge校验] ${modelName} 输出未通过 Zod，触发单次重试: ${issues}`);
      const retryMessages: BaseMessage[] = [
        ...baseMessages,
        new AIMessage(JSON.stringify(output)),
        new HumanMessage(
          `你的输出未通过校验：${issues}\n请修正后重新输出，只输出符合 Schema 的 JSON。`,
        ),
      ];
      output = JudgeOutputSchema.parse(
        await model.invoke(retryMessages, {
          ...this.langfuse.trace({
            runName: 'judge-retry',
            gameId,
            playerId,
            modelName,
            scenario: 'judge',
            seatNo,
            role,
            promptName,
            promptVersion,
          }),
        }),
      );
    }

    return { ...(output as JudgeOutput), modelName };
  }
}

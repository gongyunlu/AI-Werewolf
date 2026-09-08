import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { GameReviewOutputSchema, type GameReviewOutput } from './reflection-schema';
import { buildGameReviewVariables, type ReviewPlayer } from './reflection-prompt';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';

/** 复盘结果，作为各玩家反思的共同输入 */
export interface GameReviewResult {
  review: GameReviewOutput;
  players: ReviewPlayer[];
}

/**
 * 对局级开眼复盘：一次上帝视角调用，产出复盘正文、关键转折与板子规律。
 *
 * 存在的意义是省掉「6 个玩家各自重新消化一遍整局」——那既是 context 爆炸的根源，
 * 也让整体判断退化成 6 份各自臆测。
 */
@Injectable()
export class GameReviewService {
  private readonly logger = new Logger(GameReviewService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly promptService: PromptService,
    private readonly structuredLlm: StructuredLlmService,
  ) {}

  /** 读取已生成的复盘；未生成时返回 null */
  async loadReview(gameId: string): Promise<GameReviewOutput | null> {
    const summary = await this.prisma.gameSummary.findUnique({
      where: { gameId },
      select: { narrative: true },
    });
    if (!summary?.narrative) return null;

    try {
      const parsed = GameReviewOutputSchema.safeParse(JSON.parse(summary.narrative));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      this.logger.warn(
        { gameId, err: error instanceof Error ? error.message : String(error) },
        '已存复盘不是合法 JSON，将按缺失处理',
      );
      return null;
    }
  }

  /**
   * 生成对局级复盘并写入 GameSummary.narrative。
   *
   * @param force - 已有复盘时是否重新生成
   */
  async reviewGame(gameId: string, force = false): Promise<GameReviewResult> {
    const players = await this.loadPlayers(gameId);

    if (!force) {
      const existing = await this.loadReview(gameId);
      if (existing) {
        this.logger.log({ gameId }, '复盘已存在，跳过生成');
        return { review: existing, players };
      }
    }

    const summary = await this.prisma.gameSummary.findUnique({
      where: { gameId },
      select: { winnerFaction: true, totalDays: true },
    });
    if (!summary) {
      throw new Error(`Game ${gameId} 尚未结算，无法复盘`);
    }

    const [events, speechSummaries, judgments] = await Promise.all([
      this.prisma.event.findMany({
        where: { gameId },
        select: {
          sequence: true,
          day: true,
          actionType: true,
          visibility: true,
          actorId: true,
          content: true,
        },
        orderBy: { sequence: 'asc' },
      }),
      this.prisma.speechSummary.findMany({
        where: { gameId },
        select: { day: true, seatNo: true, summary: true },
      }),
      this.prisma.decisionJudgment.findMany({
        where: { gameId, evaluationVersion: EVALUATION_VERSION },
        select: {
          playerId: true,
          actionType: true,
          day: true,
          targetSeatNo: true,
          verdict: true,
          score: true,
          reasoning: true,
        },
      }),
    ]);

    const variables = buildGameReviewVariables({
      winnerFaction: summary.winnerFaction,
      totalDays: summary.totalDays,
      players,
      events: events.map((e) => ({
        sequence: e.sequence,
        day: e.day,
        actionType: e.actionType,
        visibility: e.visibility,
        actorId: e.actorId,
        content: (e.content as Record<string, unknown>) ?? {},
      })),
      speechSummaries,
      judgments,
    });

    const [systemPrompt, userPrompt] = await Promise.all([
      this.promptService.render(PROMPT_NAMES.gameReviewSystem),
      this.promptService.render(PROMPT_NAMES.gameReviewUser, variables),
    ]);

    const { output } = await this.structuredLlm.invoke({
      schema: GameReviewOutputSchema,
      runName: 'game-review',
      scenario: 'reflection',
      system: systemPrompt.text,
      user: userPrompt.text,
      gameId,
      // 复盘不属于任何单个玩家，LangFuse 的 user 维度用 gameId 占位
      playerId: gameId,
      promptName: userPrompt.name,
      promptVersion: userPrompt.version,
    });

    await this.prisma.gameSummary.update({
      where: { gameId },
      data: { narrative: JSON.stringify(output) },
    });

    this.logger.log({ gameId, patterns: output.patterns.length }, '对局复盘完成');
    return { review: output, players };
  }

  /** 全员真实身份 + 胜负（复盘是开眼的） */
  private async loadPlayers(gameId: string): Promise<ReviewPlayer[]> {
    const rows = await this.prisma.player.findMany({
      where: { gameId },
      select: {
        id: true,
        seatNo: true,
        role: true,
        faction: true,
        deathDay: true,
        agent: { select: { name: true } },
        agentPerformances: { select: { isWinner: true }, take: 1 },
      },
      orderBy: { seatNo: 'asc' },
    });

    return rows.map((p) => ({
      playerId: p.id,
      seatNo: p.seatNo,
      agentName: p.agent.name,
      role: p.role ?? '',
      faction: p.faction ?? '',
      deathDay: p.deathDay,
      isWinner: p.agentPerformances[0]?.isWinner ?? false,
    }));
  }
}

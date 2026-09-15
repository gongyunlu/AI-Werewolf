import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { GameReviewOutputSchema, type GameReviewOutput } from './reflection-schema';
import { buildGameReviewVariables, type ReviewPlayer } from './reflection-prompt';
import { EVALUATION_VERSION } from '../evaluation/evaluation-version';
import {
  loadPlatformEvaluationRun,
  lockReflectionEvaluation,
  reviewMatchesEvaluation,
} from './evaluation-reference';

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

  /** 读取已生成的复盘；未生成或与当前评分运行对不上时返回 null */
  async loadReview(
    gameId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<GameReviewOutput | null> {
    const [summary, run] = await Promise.all([
      db.gameSummary.findUnique({ where: { gameId }, select: { narrative: true } }),
      loadPlatformEvaluationRun(db, gameId),
    ]);
    if (!summary?.narrative) return null;
    if (run && (run.status !== 'complete' || !reviewMatchesEvaluation(summary.narrative, run.id)))
      return null;
    return this.parseReviewOutput(gameId, summary.narrative);
  }

  /**
   * 读取已存复盘，不校验评分运行。
   *
   * 复盘生成后紧接着的规律晋升要用这条路径：它取的是刚写进去的那一份，
   * 而重评会让「当前评分运行」对不上，不代表已存聚类失效。
   */
  async loadStoredReview(gameId: string): Promise<GameReviewOutput | null> {
    const summary = await this.prisma.gameSummary.findUnique({
      where: { gameId },
      select: { narrative: true },
    });
    return summary?.narrative ? this.parseReviewOutput(gameId, summary.narrative) : null;
  }

  private parseReviewOutput(gameId: string, narrative: string): GameReviewOutput | null {
    try {
      const parsed = GameReviewOutputSchema.safeParse(JSON.parse(narrative));
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
    const snapshot = await this.prisma.$transaction(async (tx) => {
      const evaluationRunId = await lockReflectionEvaluation(tx, gameId);
      if (!force) {
        const existing = await this.loadReview(gameId, tx);
        if (existing) return { existing };
      }

      const summary = await tx.gameSummary.findUnique({
        where: { gameId },
        select: { winnerFaction: true, totalDays: true },
      });
      if (!summary) {
        throw new Error(`Game ${gameId} 尚未结算，无法复盘`);
      }

      const [events, speechSummaries, judgments] = await Promise.all([
        tx.event.findMany({
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
        tx.speechSummary.findMany({
          where: { gameId },
          select: { day: true, seatNo: true, summary: true },
        }),
        tx.decisionJudgment.findMany({
          where: {
            gameId,
            evaluationVersion: EVALUATION_VERSION,
            ...(evaluationRunId ? { evaluationRunId } : {}),
          },
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
      return { evaluationRunId, summary, events, speechSummaries, judgments };
    });
    if (snapshot.existing) {
      this.logger.log({ gameId }, '复盘已存在，跳过生成');
      return { review: snapshot.existing, players };
    }
    const { evaluationRunId, summary, events, speechSummaries, judgments } = snapshot;

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
      promptSource: userPrompt.source,
      promptOrigin: userPrompt.origin,
    });

    await this.prisma.$transaction(async (tx) => {
      await lockReflectionEvaluation(tx, gameId, { runId: evaluationRunId });
      await tx.gameSummary.update({
        where: { gameId },
        data: {
          narrative: JSON.stringify({ ...output, ...(evaluationRunId ? { evaluationRunId } : {}) }),
        },
      });
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

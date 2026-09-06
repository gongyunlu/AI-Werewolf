import { InjectFlowProducer } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { FlowProducer } from 'bullmq';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  JUDGE_JOB_OPTIONS,
  JUDGE_QUEUE_NAME,
  JudgeQueueService,
} from '../evaluation/judge-queue.service';
import { SettlementService } from '../evaluation/settlement.service';
import { JudgeService } from '../evaluation/judge.service';
import {
  buildReviewJobId,
  REFLECT_FLOW_PRODUCER,
  REFLECT_JOB_NAMES,
  REFLECT_JOB_OPTIONS,
  REFLECT_QUEUE_NAME,
  ReflectionQueueService,
  type ScheduleLease,
} from './reflection-queue.service';

export interface AnalyzeGameOptions {
  /** 是否重跑决策与发言评分，默认 true */
  judge?: boolean;
  /** 是否重跑复盘与反思，默认 true */
  reflect?: boolean;
  /** 只反思指定玩家 */
  playerId?: string;
  /** 绕过幂等强制重跑；反思重跑会先软删除本局旧记忆 */
  force?: boolean;
}

export interface AnalyzeGameResult {
  judged: number;
  reflectPlanned: number;
  /** 本次是否实际投递而非跳过。false 时 judged/reflectPlanned 均为 0，
   *  原因是已有流程在运行/已完成等原因，见分析日志。前端据此区分「投了 0 项」与「没投」。 */
  skipped: boolean;
}

export interface AnalysisStatus {
  judgedCount: number;
  judgeableCount: number;
  reflectedCount: number;
  playerCount: number;
  narrativeReady: boolean;
}

interface AnalysisProgress {
  judgeComplete: boolean;
  reflectComplete: boolean;
  narrativeReady: boolean;
  reflectedCount: number;
  hasArtifacts: boolean;
}

const IN_FLIGHT_FANOUT_STATES = new Set([
  'active',
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
]);

/**
 * 赛后分析的唯一入口：对局结束自动调用与前端手动触发走同一条路径。
 *
 * judge 与反思之间用 BullMQ flow 的父子依赖表达先后，而不是让反思去轮询或重试等待——
 * 一局约二十多个 judge 任务在 concurrency=2 下要跑近一分钟，重试次数根本等不到。
 */
@Injectable()
export class GameAnalysisService {
  private readonly logger = new Logger(GameAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly judgeQueueService: JudgeQueueService,
    private readonly reflectionQueueService: ReflectionQueueService,
    private readonly settlementService: SettlementService,
    private readonly judgeService: JudgeService,
    @InjectFlowProducer(REFLECT_FLOW_PRODUCER) private readonly flowProducer: FlowProducer,
  ) {}

  async analyzeGame(gameId: string, options: AnalyzeGameOptions = {}): Promise<AnalyzeGameResult> {
    const locked = await this.reflectionQueueService.withGameScheduleLock(gameId, (lease) =>
      this.analyzeGameLocked(gameId, options, lease),
    );
    if (!locked.acquired) {
      // 不能把锁竞争当作“已成功投递”：若持锁进程恰好崩溃且尚未 add flow，
      // GameWorker 会错误完成。抛可重试冲突，让自动任务稍后重新确认持久化/队列状态。
      throw new ConflictException(`对局 ${gameId} 正在调度赛后分析，请稍后重试`);
    }
    return locked.value;
  }

  private async analyzeGameLocked(
    gameId: string,
    options: AnalyzeGameOptions = {},
    lease: ScheduleLease,
  ): Promise<AnalyzeGameResult> {
    const { playerId, force = false } = options;
    const judge = options.judge ?? true;
    const reflect = options.reflect ?? true;

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true, _count: { select: { players: true } } },
    });
    if (!game) throw new NotFoundException(`对局 ${gameId} 不存在`);
    if (game.status !== GAME_STATUSES.FINISHED) {
      throw new BadRequestException(`对局 ${gameId} 尚未结束，无法分析`);
    }
    if (!judge && !reflect) {
      throw new BadRequestException('judge 与 reflect 至少要开启一项');
    }
    if (playerId) {
      const targetPlayer = await this.prisma.player.findUnique({
        where: { id: playerId },
        select: { gameId: true },
      });
      if (!targetPlayer || targetPlayer.gameId !== gameId) {
        throw new BadRequestException(`玩家 ${playerId} 不属于对局 ${gameId}`);
      }
    }

    // 先结算确定性指标再投递：复盘依赖 GameSummary，结算失败会在此同步抛错，
    // 而不是把错误推迟到后台队列。settleGame 幂等（upsert），重复调用无副作用。
    await this.settlementService.settleGame(gameId);

    const reflectPlanned = reflect ? (playerId ? 1 : game._count.players) : 0;

    // force 使用不同 jobId；按稳定 id 去重仍挡不住连续点击。先检查任意后缀的在途 fanout，
    // 避免两版 game review 与两批 player reflection 并发交错。
    const [reflectionInFlight, judgeInFlight] = await Promise.all([
      this.reflectionQueueService.hasInFlightFanout(gameId),
      this.judgeQueueService.hasInFlightGame(gameId),
    ]);
    if (reflectionInFlight || judgeInFlight) {
      this.logger.log({ gameId }, '该对局已有赛后分析流程运行中，跳过重复投递');
      return { judged: 0, reflectPlanned: 0, skipped: true };
    }

    if (judge && reflect) {
      const progress = await this.loadAnalysisProgress(
        gameId,
        playerId,
        playerId ? 1 : game._count.players,
      );

      if (!force && progress.judgeComplete && progress.reflectComplete) {
        this.logger.log({ gameId, playerId }, '赛后分析已完成，跳过重复投递');
        return { judged: 0, reflectPlanned: 0, skipped: true };
      }

      // 非 force 的首次运行使用稳定 jobId；重复请求若发现该 flow 仍在队列中，直接复用。
      // failed flow 不能复用（其 child 已耗尽 attempts），需用恢复后缀重新投递。
      const stableFlowState = force
        ? null
        : await this.reflectionQueueService.getFanoutState(gameId);
      if (stableFlowState && IN_FLIGHT_FANOUT_STATES.has(stableFlowState)) {
        this.logger.log({ gameId, state: stableFlowState }, '赛后分析流程已存在，跳过重复投递');
        return { judged: 0, reflectPlanned: 0, skipped: true };
      }

      // judge-only 的稳定 completion 也可能仍保留着同一批 child。BullMQ 不允许一个
      // 已有 parent 的 child 在旧 parent 尚存时改挂到新 parent，故这种恢复也必须换后缀。
      const stableJudgeState = force
        ? null
        : await this.judgeQueueService.getCompletionState(gameId);
      const isResume =
        !force && (stableFlowState !== null || stableJudgeState !== null || progress.hasArtifacts);
      // 分隔符用下划线：FlowProducer 拒绝含冒号的 jobId。
      // 只有 force/恢复运行需要新后缀；普通首次分析的稳定 id 提供队列级幂等。
      const suffix = force ? `_run_${Date.now()}` : isResume ? `_resume_${Date.now()}` : '';

      // 如果 judge 已完整，只补复盘/玩家反思，不重新评分。已有复盘可以被安全复用；
      // 仅当评分不完整却已有派生产物，或出现「有反思但无复盘」时，才强制刷新派生产物。
      const refreshDerivedArtifacts =
        force ||
        (!progress.judgeComplete && (progress.narrativeReady || progress.reflectedCount > 0)) ||
        (!progress.narrativeReady && progress.reflectedCount > 0);

      if (!force && progress.judgeComplete) {
        await lease.assertOwned();
        await this.reflectionQueueService.enqueueFanout({
          gameId,
          force: refreshDerivedArtifacts,
          playerId,
          suffix: suffix || undefined,
          // judge+reflect 恢复路径也必须严格回填；上一次可能正是 backfill 失败后中断。
          refreshRewards: true,
        });
        this.logger.log({ gameId, reflectPlanned }, '评分已完整，已投递复盘与反思');
        return { judged: 0, reflectPlanned, skipped: false };
      }

      const children = await this.judgeQueueService.listGameJobs(gameId, suffix);
      await lease.assertOwned();
      await this.flowProducer.add({
        name: REFLECT_JOB_NAMES.fanout,
        queueName: REFLECT_QUEUE_NAME,
        data: {
          gameId,
          force: refreshDerivedArtifacts,
          playerId,
          suffix,
          refreshRewards: true,
        },
        opts: { ...REFLECT_JOB_OPTIONS, jobId: buildReviewJobId(gameId, suffix) },
        children: children.map((child) => ({
          name: child.name,
          queueName: JUDGE_QUEUE_NAME,
          data: child.data,
          opts: {
            ...JUDGE_JOB_OPTIONS,
            jobId: child.jobId,
            // 任一评分最终失败都不能把「未评分」伪装成「没有不佳行为」。
            // 等 child 自己耗尽 attempts 后，让 BullMQ 直接阻止并标记 fanout 失败。
            failParentOnFailure: true,
          },
        })),
      });

      this.logger.log({ gameId, judged: children.length, reflectPlanned }, '已投递赛后分析流程');
      return { judged: children.length, reflectPlanned, skipped: false };
    }

    if (judge) {
      if (!force) {
        const [judgeableCount, judgedCount] = await Promise.all([
          this.judgeService.countJudgeableTargets(gameId),
          this.prisma.decisionJudgment.count({ where: { gameId } }),
        ]);
        if (judgedCount >= judgeableCount) {
          // 不需要重评，但仍严格刷新一次 reward，修复旧 completion 可能遗漏的派生数据。
          await this.judgeService.backfillRewards(gameId);
          await this.judgeService.aggregatePlayerScores(gameId);
          this.logger.log({ gameId }, '评分已完整，已刷新 reward，跳过重复投递');
          return { judged: 0, reflectPlanned: 0, skipped: true };
        }
      }

      const stableJudgeState = force
        ? null
        : await this.judgeQueueService.getCompletionState(gameId);
      const suffix = !force && stableJudgeState !== null ? `_resume_${Date.now()}` : '';
      await lease.assertOwned();
      const judged = force
        ? await this.judgeQueueService.rejudgeGame(gameId)
        : await this.judgeQueueService.enqueueGame(gameId, suffix);
      this.logger.log({ gameId, judged }, '已投递决策与发言评分');
      return { judged, reflectPlanned: 0, skipped: false };
    }

    // 只重跑反思时复用已有评分，不重跑二十多次决策评估。
    // 已完成/失败的稳定 jobId 仍会在队列保留一段时间，补跑必须换 resume 后缀。
    const progress = await this.loadAnalysisProgress(
      gameId,
      playerId,
      playerId ? 1 : game._count.players,
    );
    if (!force && progress.reflectComplete) {
      this.logger.log({ gameId, playerId }, '复盘与反思已完成，跳过重复投递');
      return { judged: 0, reflectPlanned: 0, skipped: true };
    }

    const stableFlowState = force ? null : await this.reflectionQueueService.getFanoutState(gameId);
    if (stableFlowState && IN_FLIGHT_FANOUT_STATES.has(stableFlowState)) {
      this.logger.log({ gameId, state: stableFlowState }, '反思流程已存在，跳过重复投递');
      return { judged: 0, reflectPlanned: 0, skipped: true };
    }

    const suffix = force
      ? `_run_${Date.now()}`
      : stableFlowState !== null || progress.hasArtifacts
        ? `_resume_${Date.now()}`
        : undefined;
    await lease.assertOwned();
    await this.reflectionQueueService.enqueueFanout({
      gameId,
      force,
      playerId,
      suffix,
    });
    this.logger.log({ gameId, reflectPlanned }, '已投递复盘与反思');
    return { judged: 0, reflectPlanned, skipped: false };
  }

  /** 读取完整分析的持久化进度；队列 job 只负责运行中去重，最终幂等以这些产物为准。 */
  private async loadAnalysisProgress(
    gameId: string,
    playerId: string | undefined,
    expectedReflections: number,
  ): Promise<AnalysisProgress> {
    const [judgeableCount, judgedCount, reflectedCount, summary] = await Promise.all([
      this.judgeService.countJudgeableTargets(gameId),
      this.prisma.decisionJudgment.count({ where: { gameId } }),
      this.prisma.agentPerformance.count({
        where: {
          gameId,
          reflectionGenerated: true,
          ...(playerId ? { playerId } : {}),
        },
      }),
      this.prisma.gameSummary.findUnique({ where: { gameId }, select: { narrative: true } }),
    ]);

    const narrativeReady = !!summary?.narrative;
    const judgeComplete = judgedCount >= judgeableCount;
    const reflectComplete = narrativeReady && reflectedCount >= expectedReflections;

    return {
      judgeComplete,
      reflectComplete,
      narrativeReady,
      reflectedCount,
      hasArtifacts: judgedCount > 0 || reflectedCount > 0 || narrativeReady,
    };
  }

  async getStatus(gameId: string): Promise<AnalysisStatus> {
    const game = await this.prisma.game.findUnique({ where: { id: gameId }, select: { id: true } });
    if (!game) throw new NotFoundException(`对局 ${gameId} 不存在`);

    const [judgeableCount, judgedCount, playerCount, reflectedCount, summary] = await Promise.all([
      this.judgeService.countJudgeableTargets(gameId),
      this.prisma.decisionJudgment.count({ where: { gameId } }),
      this.prisma.player.count({ where: { gameId } }),
      this.prisma.agentPerformance.count({ where: { gameId, reflectionGenerated: true } }),
      this.prisma.gameSummary.findUnique({ where: { gameId }, select: { narrative: true } }),
    ]);

    return {
      judgedCount,
      judgeableCount,
      reflectedCount,
      playerCount,
      narrativeReady: !!summary?.narrative,
    };
  }
}

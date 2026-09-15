import { GAME_STATUSES } from '@ai-werewolf/shared';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { FlowProducer } from 'bullmq';
import type { PrismaService } from '../prisma/prisma.service';
import type { JudgeQueueService } from '../evaluation/judge-queue.service';
import type { SettlementService } from '../evaluation/settlement.service';
import type { JudgeService } from '../evaluation/judge.service';
import { GameAnalysisService } from './game-analysis.service';
import {
  REFLECT_JOB_NAMES,
  REFLECT_QUEUE_NAME,
  type ReflectionQueueService,
} from './reflection-queue.service';

describe('GameAnalysisService', () => {
  const gameId = '00000000-0000-4000-8000-000000000001';
  const now = 1_756_300_000_000;

  const prisma = {
    game: { findUnique: jest.fn(), findMany: jest.fn() },
    player: { findUnique: jest.fn(), count: jest.fn() },
    evaluationRun: { findFirst: jest.fn() },
    agentPerformance: { count: jest.fn() },
    gameSummary: { findUnique: jest.fn() },
  };
  const judgeQueue = {
    listGameJobs: jest.fn(),
    resolveRunId: jest.fn(),
    enqueueGame: jest.fn(),
    rejudgeGame: jest.fn(),
    hasInFlightGame: jest.fn(),
    getCompletionState: jest.fn(),
  };
  const reflectionQueue = {
    withGameScheduleLock: jest.fn(),
    hasInFlightFanout: jest.fn(),
    getFanoutState: jest.fn(),
    enqueueFanout: jest.fn(),
  };
  const settlement = { settleGame: jest.fn() };
  const judge = {
    getEvaluationProgress: jest.fn(),
    backfillRewards: jest.fn(),
    aggregatePlayerScores: jest.fn(),
  };
  const flowProducer = { add: jest.fn() };
  const scheduleLease = { assertOwned: jest.fn() };

  let service: GameAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);

    prisma.game.findUnique.mockResolvedValue({
      status: GAME_STATUSES.FINISHED,
      _count: { players: 6 },
    });
    prisma.player.findUnique.mockResolvedValue({ gameId });
    prisma.player.count.mockResolvedValue(6);
    prisma.evaluationRun.findFirst.mockResolvedValue(null);
    prisma.agentPerformance.count.mockResolvedValue(0);
    prisma.gameSummary.findUnique.mockResolvedValue({ narrative: null });
    judge.getEvaluationProgress.mockResolvedValue({
      complete: false,
      judgedCount: 0,
      judgeableCount: 2,
    });
    judge.backfillRewards.mockResolvedValue(0);
    judge.aggregatePlayerScores.mockResolvedValue(undefined);
    reflectionQueue.withGameScheduleLock.mockImplementation(
      async (_gameId: string, task: (lease: typeof scheduleLease) => Promise<unknown>) => ({
        acquired: true,
        value: await task(scheduleLease),
      }),
    );
    reflectionQueue.hasInFlightFanout.mockResolvedValue(false);
    judgeQueue.hasInFlightGame.mockResolvedValue(false);
    judgeQueue.getCompletionState.mockResolvedValue(null);
    judgeQueue.resolveRunId.mockResolvedValue(`${gameId}_initial`);
    reflectionQueue.getFanoutState.mockResolvedValue(null);
    settlement.settleGame.mockResolvedValue(undefined);
    flowProducer.add.mockResolvedValue(undefined);
    judgeQueue.listGameJobs.mockResolvedValue([
      {
        name: 'judge-decision',
        data: { gameId, eventId: 'event-1', runId: `${gameId}_initial` },
        jobId: 'event-1',
      },
    ]);

    service = new GameAnalysisService(
      prisma as unknown as PrismaService,
      judgeQueue as unknown as JudgeQueueService,
      reflectionQueue as unknown as ReflectionQueueService,
      settlement as unknown as SettlementService,
      judge as unknown as JudgeService,
      flowProducer as unknown as FlowProducer,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('同局调度锁被占用时抛可重试冲突，不伪报投递成功', async () => {
    reflectionQueue.withGameScheduleLock.mockResolvedValueOnce({ acquired: false });

    await expect(service.analyzeGame(gameId)).rejects.toBeInstanceOf(ConflictException);
    expect(settlement.settleGame).not.toHaveBeenCalled();
  });

  it('批量重评逐局隔离：单局投递失败不中断其余对局', async () => {
    const okGame = '00000000-0000-4000-8000-000000000011';
    const failedGame = '00000000-0000-4000-8000-000000000012';
    const busyGame = '00000000-0000-4000-8000-000000000013';
    prisma.game.findMany.mockResolvedValue([{ id: okGame }, { id: failedGame }, { id: busyGame }]);
    settlement.settleGame.mockImplementation(async (id: string) => {
      if (id === failedGame) throw new Error('结算失败');
    });
    judgeQueue.hasInFlightGame.mockImplementation(async (id: string) => id === busyGame);
    judgeQueue.rejudgeGame.mockResolvedValue(1);

    await expect(service.rejudgeAll()).resolves.toEqual({
      games: 3,
      decisions: 1,
      skipped: 1,
      failed: [{ gameId: failedGame, reason: '结算失败' }],
    });
    expect(settlement.settleGame).toHaveBeenCalledTimes(3);
  });

  it('实验局手动反思可以投递，但不隐式重跑评分', async () => {
    prisma.game.findUnique.mockResolvedValue({
      status: GAME_STATUSES.FINISHED,
      experiment: { arm: 'off' },
      _count: { players: 6 },
    });
    await expect(
      service.analyzeGame(gameId, { judge: false, reflect: true, force: true }),
    ).resolves.toMatchObject({ judged: 0, reflectPlanned: 6, skipped: false });
    expect(reflectionQueue.enqueueFanout).toHaveBeenCalledWith(
      expect.objectContaining({ gameId, force: true }),
    );
    expect(judgeQueue.enqueueGame).not.toHaveBeenCalled();
    expect(judgeQueue.rejudgeGame).not.toHaveBeenCalled();
  });

  it('实验局自动分析仍只评分，不自动投递反思', async () => {
    prisma.game.findUnique.mockResolvedValue({
      status: GAME_STATUSES.FINISHED,
      experiment: { arm: 'on' },
      _count: { players: 6 },
    });
    judgeQueue.enqueueGame.mockResolvedValue(2);
    await expect(service.analyzeGame(gameId)).resolves.toMatchObject({
      judged: 2,
      reflectPlanned: 0,
    });
    expect(reflectionQueue.enqueueFanout).not.toHaveBeenCalled();
    expect(flowProducer.add).not.toHaveBeenCalled();
  });

  it('指定的反思玩家不属于该局时同步拒绝，不投递空任务', async () => {
    prisma.player.findUnique.mockResolvedValue({
      gameId: '00000000-0000-4000-8000-000000000099',
    });

    await expect(
      service.analyzeGame(gameId, {
        judge: false,
        reflect: true,
        playerId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(settlement.settleGame).not.toHaveBeenCalled();
    expect(reflectionQueue.enqueueFanout).not.toHaveBeenCalled();
  });

  it('持久化分析已经完整时，force=false 不重复投递任何任务', async () => {
    judge.getEvaluationProgress.mockResolvedValue({
      complete: true,
      judgedCount: 8,
      judgeableCount: 8,
    });
    prisma.agentPerformance.count.mockResolvedValue(6);
    prisma.gameSummary.findUnique.mockResolvedValue({ narrative: '{"narrative":"done"}' });

    await expect(service.analyzeGame(gameId)).resolves.toMatchObject({
      judged: 0,
      reflectPlanned: 0,
    });

    expect(settlement.settleGame).toHaveBeenCalledWith(gameId);
    expect(reflectionQueue.getFanoutState).not.toHaveBeenCalled();
    expect(judgeQueue.listGameJobs).not.toHaveBeenCalled();
    expect(flowProducer.add).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    '共享校验未通过时恢复评分，即使评分数量齐全（反思=%s）',
    async (reflect) => {
      judge.getEvaluationProgress.mockResolvedValue({
        runId: 'pending-run',
        complete: false,
        judgedCount: 8,
        judgeableCount: 8,
      });
      prisma.agentPerformance.count.mockResolvedValue(6);
      prisma.gameSummary.findUnique.mockResolvedValue({ narrative: 'done' });
      await service.analyzeGame(gameId, { judge: true, reflect });
      if (reflect) expect(judgeQueue.listGameJobs).toHaveBeenCalled();
      else expect(judgeQueue.enqueueGame).toHaveBeenCalledWith(gameId, `_resume_${now}`);
    },
  );

  it('首次完整分析使用稳定 jobId，并让任一 judge 最终失败直接使 fanout 失败', async () => {
    const result = await service.analyzeGame(gameId);

    expect(result).toEqual({ judged: 1, reflectPlanned: 6, skipped: false });
    expect(judgeQueue.listGameJobs).toHaveBeenCalledWith(gameId, '');
    expect(flowProducer.add).toHaveBeenCalledWith(
      expect.objectContaining({
        name: REFLECT_JOB_NAMES.fanout,
        queueName: REFLECT_QUEUE_NAME,
        data: expect.objectContaining({
          gameId,
          evaluationRunId: `${gameId}_initial`,
          force: false,
          suffix: '',
          refreshRewards: true,
        }),
        opts: expect.objectContaining({ jobId: `review_${gameId}` }),
        children: [
          expect.objectContaining({
            opts: expect.objectContaining({
              jobId: 'event-1',
              failParentOnFailure: true,
            }),
          }),
        ],
      }),
    );
    const flow = flowProducer.add.mock.calls[0][0];
    expect(flow.children[0].opts.ignoreDependencyOnFailure).toBeUndefined();
  });

  it('稳定 fanout 仍在队列中时复用现有运行，不重复投递', async () => {
    reflectionQueue.getFanoutState.mockResolvedValue('waiting-children');

    await expect(service.analyzeGame(gameId)).resolves.toMatchObject({
      judged: 0,
      reflectPlanned: 0,
    });

    expect(judgeQueue.listGameJobs).not.toHaveBeenCalled();
    expect(flowProducer.add).not.toHaveBeenCalled();
  });

  it('即使 force 使用新后缀，同局已有任意 fanout 在途时也不并发投递', async () => {
    reflectionQueue.hasInFlightFanout.mockResolvedValue(true);

    await expect(service.analyzeGame(gameId, { force: true })).resolves.toMatchObject({
      judged: 0,
      reflectPlanned: 0,
    });

    expect(reflectionQueue.getFanoutState).not.toHaveBeenCalled();
    expect(flowProducer.add).not.toHaveBeenCalled();
  });

  it('judge-only force 遇到同局评分任务在途时不重复投递', async () => {
    judgeQueue.hasInFlightGame.mockResolvedValue(true);

    await expect(
      service.analyzeGame(gameId, { judge: true, reflect: false, force: true }),
    ).resolves.toMatchObject({ judged: 0, reflectPlanned: 0 });

    expect(judgeQueue.rejudgeGame).not.toHaveBeenCalled();
    expect(scheduleLease.assertOwned).not.toHaveBeenCalled();
  });

  it('judge-only 非 force 在评分完整时只刷新 reward，不重复创建 flow', async () => {
    judge.getEvaluationProgress.mockResolvedValue({
      complete: true,
      judgedCount: 2,
      judgeableCount: 2,
    });
    judge.backfillRewards.mockResolvedValue(2);

    await expect(
      service.analyzeGame(gameId, { judge: true, reflect: false }),
    ).resolves.toMatchObject({ judged: 0, reflectPlanned: 0 });

    expect(judge.backfillRewards).toHaveBeenCalledWith(gameId);
    expect(judge.aggregatePlayerScores).toHaveBeenCalledWith(gameId);
    expect(judgeQueue.enqueueGame).not.toHaveBeenCalled();
  });

  it('judge-only 稳定 completion 已终结但评分不完整时用恢复后缀', async () => {
    judgeQueue.getCompletionState.mockResolvedValue('failed');
    judgeQueue.enqueueGame.mockResolvedValue(2);

    await expect(
      service.analyzeGame(gameId, { judge: true, reflect: false }),
    ).resolves.toMatchObject({ judged: 2, reflectPlanned: 0 });

    expect(judgeQueue.enqueueGame).toHaveBeenCalledWith(gameId, `_resume_${now}`);
  });

  it.each(['failed', 'completed'] as const)(
    '稳定 flow 状态为 %s 且产物不完整时用恢复后缀重新投递',
    async (state) => {
      reflectionQueue.getFanoutState.mockResolvedValue(state);
      judge.getEvaluationProgress.mockResolvedValue({
        complete: false,
        judgedCount: 1,
        judgeableCount: 2,
      });
      judgeQueue.listGameJobs.mockImplementation(async (_id: string, suffix: string) => [
        {
          name: 'judge-decision',
          data: { gameId, eventId: 'event-1', runId: 'original-run' },
          jobId: `event-1${suffix}`,
        },
      ]);

      await service.analyzeGame(gameId);

      const suffix = `_resume_${now}`;
      expect(judgeQueue.listGameJobs).toHaveBeenCalledWith(gameId, suffix);
      expect(flowProducer.add).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            suffix,
            force: false,
            refreshRewards: true,
            evaluationRunId: 'original-run',
          }),
          opts: expect.objectContaining({ jobId: `review_${gameId}${suffix}` }),
        }),
      );
    },
  );

  it('首次 combined 遇到已终结的 judge-only 稳定 flow 时也切换恢复后缀', async () => {
    judgeQueue.getCompletionState.mockResolvedValue('failed');

    await service.analyzeGame(gameId);

    expect(judgeQueue.listGameJobs).toHaveBeenCalledWith(gameId, `_resume_${now}`);
  });

  it('评分已经完整时只补复盘和反思，不重新 judge', async () => {
    judge.getEvaluationProgress.mockResolvedValue({
      complete: true,
      judgedCount: 2,
      judgeableCount: 2,
    });

    await expect(service.analyzeGame(gameId)).resolves.toMatchObject({
      judged: 0,
      reflectPlanned: 6,
    });

    expect(judgeQueue.listGameJobs).not.toHaveBeenCalled();
    expect(flowProducer.add).not.toHaveBeenCalled();
    expect(reflectionQueue.enqueueFanout).toHaveBeenCalledWith({
      gameId,
      force: false,
      playerId: undefined,
      refreshRewards: true,
      suffix: `_resume_${now}`,
    });
  });

  it('只补反思时，已完成的旧 fanout 不会阻塞缺失产物恢复', async () => {
    reflectionQueue.getFanoutState.mockResolvedValue('completed');

    await expect(
      service.analyzeGame(gameId, { judge: false, reflect: true }),
    ).resolves.toMatchObject({ judged: 0, reflectPlanned: 6 });

    expect(reflectionQueue.enqueueFanout).toHaveBeenCalledWith({
      gameId,
      force: false,
      playerId: undefined,
      suffix: `_resume_${now}`,
    });
  });

  it.each([true, false])(
    '新平台完整评分采用后，旧产物待刷新并自动 force（评分=%s）',
    async (judgeEnabled) => {
      prisma.evaluationRun.findFirst.mockResolvedValue({
        id: 'new-run',
        status: 'complete',
        definition: {},
      });
      judge.getEvaluationProgress.mockResolvedValue({
        runId: 'new-run',
        complete: true,
        judgedCount: 2,
        judgeableCount: 2,
      });
      prisma.gameSummary.findUnique.mockResolvedValue({
        narrative: JSON.stringify({ narrative: '旧复盘', evaluationRunId: 'old-run' }),
      });
      prisma.agentPerformance.count.mockImplementation(async (args) =>
        args.where.metadata ? 0 : 6,
      );

      expect(await service.getStatus(gameId)).toMatchObject({
        narrativeReady: false,
        reflectedCount: 0,
      });
      await service.analyzeGame(gameId, { judge: judgeEnabled, reflect: true });
      expect(reflectionQueue.enqueueFanout).toHaveBeenCalledWith(
        expect.objectContaining({ gameId, force: true }),
      );
      expect(judgeQueue.listGameJobs).not.toHaveBeenCalled();
    },
  );

  it('新平台运行尚未完整时不把旧产物算作最新，也不允许离线反思混读', async () => {
    prisma.evaluationRun.findFirst.mockResolvedValue({
      id: 'pending-run',
      status: 'pending',
      definition: {},
    });
    judge.getEvaluationProgress.mockResolvedValue({
      runId: 'pending-run',
      complete: false,
      judgedCount: 2,
      judgeableCount: 2,
    });
    prisma.gameSummary.findUnique.mockResolvedValue({ narrative: '{"narrative":"旧复盘"}' });
    prisma.agentPerformance.count.mockResolvedValue(6);

    expect(await service.getStatus(gameId)).toMatchObject({
      narrativeReady: false,
      reflectedCount: 0,
    });
    await expect(
      service.analyzeGame(gameId, { judge: false, reflect: true, force: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(reflectionQueue.enqueueFanout).not.toHaveBeenCalled();
  });

  it('引用当前完整平台运行的复盘与反思仍保持幂等', async () => {
    prisma.evaluationRun.findFirst.mockResolvedValue({
      id: 'new-run',
      status: 'complete',
      definition: {},
    });
    judge.getEvaluationProgress.mockResolvedValue({
      runId: 'new-run',
      complete: true,
      judgedCount: 2,
      judgeableCount: 2,
    });
    prisma.gameSummary.findUnique.mockResolvedValue({
      narrative: JSON.stringify({ narrative: '新复盘', evaluationRunId: 'new-run' }),
    });
    prisma.agentPerformance.count.mockResolvedValue(6);

    expect(await service.getStatus(gameId)).toMatchObject({
      narrativeReady: true,
      reflectedCount: 6,
    });
    expect(prisma.agentPerformance.count).toHaveBeenCalledWith({
      where: {
        gameId,
        reflectionGenerated: true,
        metadata: { path: ['reflectionEvaluationRunId'], equals: 'new-run' },
      },
    });
    expect(await service.analyzeGame(gameId)).toMatchObject({ skipped: true });
    expect(reflectionQueue.enqueueFanout).not.toHaveBeenCalled();
  });
});

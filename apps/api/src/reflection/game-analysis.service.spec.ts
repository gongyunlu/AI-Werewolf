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
    game: { findUnique: jest.fn() },
    player: { findUnique: jest.fn() },
    decisionJudgment: { count: jest.fn() },
    agentPerformance: { count: jest.fn() },
    gameSummary: { findUnique: jest.fn() },
  };
  const judgeQueue = {
    listGameJobs: jest.fn(),
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
    countJudgeableTargets: jest.fn(),
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
    prisma.decisionJudgment.count.mockResolvedValue(0);
    prisma.agentPerformance.count.mockResolvedValue(0);
    prisma.gameSummary.findUnique.mockResolvedValue({ narrative: null });
    judge.countJudgeableTargets.mockResolvedValue(2);
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
    reflectionQueue.getFanoutState.mockResolvedValue(null);
    settlement.settleGame.mockResolvedValue(undefined);
    flowProducer.add.mockResolvedValue(undefined);
    judgeQueue.listGameJobs.mockResolvedValue([
      {
        name: 'judge-decision',
        data: { gameId, eventId: 'event-1' },
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
    judge.countJudgeableTargets.mockResolvedValue(8);
    prisma.decisionJudgment.count.mockResolvedValue(8);
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
    judge.countJudgeableTargets.mockResolvedValue(2);
    prisma.decisionJudgment.count.mockResolvedValue(2);
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
      prisma.decisionJudgment.count.mockResolvedValue(1);
      judgeQueue.listGameJobs.mockImplementation(async (_id: string, suffix: string) => [
        {
          name: 'judge-decision',
          data: { gameId, eventId: 'event-1' },
          jobId: `event-1${suffix}`,
        },
      ]);

      await service.analyzeGame(gameId);

      const suffix = `_resume_${now}`;
      expect(judgeQueue.listGameJobs).toHaveBeenCalledWith(gameId, suffix);
      expect(flowProducer.add).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ suffix, force: false, refreshRewards: true }),
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
    judge.countJudgeableTargets.mockResolvedValue(2);
    prisma.decisionJudgment.count.mockResolvedValue(2);

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
});

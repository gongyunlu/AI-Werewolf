import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AnalysisController } from './analysis.controller';
import { GameAnalysisService } from './game-analysis.service';
import { EvaluationController } from '../evaluation/evaluation.controller';
import { StatisticsService } from '../evaluation/statistics.service';
import { JudgeQueueService } from '../evaluation/judge-queue.service';
import { ADMIN_TOKEN_HEADER } from '../common/guards/admin-token.guard';

const ADMIN_TOKEN = 'test-admin-token';

describe('旧评分入口沿用统一赛后调度边界', () => {
  let app: INestApplication;
  const analysis = {
    analyzeGame: jest.fn(async () => ({ judged: 3, reflectPlanned: 0, skipped: false })),
    rejudgeAll: jest.fn(async () => ({ games: 2, decisions: 6 })),
  };
  const directQueue = {
    rejudgeGame: jest.fn(async () => 99),
    rejudgeAll: jest.fn(async () => ({ games: 99, decisions: 99 })),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [EvaluationController, AnalysisController],
      providers: [
        { provide: StatisticsService, useValue: {} },
        { provide: JudgeQueueService, useValue: directQueue },
        { provide: GameAnalysisService, useValue: analysis },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'ADMIN_TOKEN' ? ADMIN_TOKEN : undefined) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('原单局重评URL和响应保留，走已有调度互斥及反思在途检查', async () => {
    const gameId = randomUUID();
    await request(app.getHttpServer())
      .post(`/evaluation/games/${gameId}/judge`)
      .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
      .expect(201)
      .expect({ gameId, judged: 3 });
    expect(analysis.analyzeGame).toHaveBeenCalledWith(gameId, {
      judge: true,
      reflect: false,
      force: true,
    });
    expect(directQueue.rejudgeGame).not.toHaveBeenCalled();
  });

  it('原批量重评URL交由统一调度服务，不直接投递Judge队列', async () => {
    await request(app.getHttpServer())
      .post('/evaluation/rejudge')
      .set(ADMIN_TOKEN_HEADER, ADMIN_TOKEN)
      .expect(201)
      .expect({ games: 2, decisions: 6 });
    expect(analysis.rejudgeAll).toHaveBeenCalledTimes(1);
    expect(directQueue.rejudgeAll).not.toHaveBeenCalled();
  });

  it('缺少admin令牌时重评入口直接拒绝，不进入调度', async () => {
    await request(app.getHttpServer()).post('/evaluation/rejudge').expect(401);
    await request(app.getHttpServer()).post(`/evaluation/games/${randomUUID()}/judge`).expect(401);
    await request(app.getHttpServer())
      .post(`/evaluation/games/${randomUUID()}/adopt-scores`)
      .send({})
      .expect(401);
    expect(analysis.rejudgeAll).not.toHaveBeenCalled();
    expect(analysis.analyzeGame).not.toHaveBeenCalled();
  });

  it('旧路径每项仅注册一次，避免模块顺序决定是否绕过调度保护', () => {
    const paths = [EvaluationController, AnalysisController].flatMap((controller) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor')
        .map((name) =>
          Reflect.getMetadata(
            PATH_METADATA,
            controller.prototype[name as keyof typeof controller.prototype],
          ),
        ),
    );
    expect(paths.filter((path) => path === 'games/:id/judge')).toHaveLength(1);
    expect(paths.filter((path) => path === 'rejudge')).toHaveLength(1);
  });
});

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { createLearningTestDatabase } from './helpers/learning-test-database';
import { EventWriterService } from '../src/game-engine/events/event-writer.service';
import { EventBusService } from '../src/event-bus/event-bus.service';
import { SseBroadcasterService } from '../src/sse/sse-broadcaster.service';
import { GameRecoveryService } from '../src/game-recovery/game-recovery.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { Prisma } from '../src/generated/prisma/client';
import type { SseMessage } from '../src/sse/sse-event.types';

describe('持久交付与恢复：真实隔离 PostgreSQL', () => {
  let database: Awaited<ReturnType<typeof createLearningTestDatabase>>;
  let prisma: PrismaService;
  let gameId: string;
  let actorId: string;
  let secondId: string;
  let writer: EventWriterService;
  let recovery: GameRecoveryService;
  let broadcaster: SseBroadcasterService;
  let bus: EventBusService;
  let messages: SseMessage[];

  beforeAll(async () => {
    database = await createLearningTestDatabase();
    prisma = database.db as unknown as PrismaService;
  });
  afterAll(async () => database?.close());
  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    await database.reset();
    await prisma.ruleset.create({
      data: { id: 'delivery', name: '交付测试', playerCount: 2, definition: {} },
    });
    gameId = (
      await prisma.game.create({
        data: { rulesetId: 'delivery', skillVersion: 'test', status: 'running' },
      })
    ).id;
    const ids: string[] = [];
    for (const seatNo of [1, 2]) {
      const agent = await prisma.agent.create({
        data: { name: randomUUID(), defaultModelName: 'mock', memoryLabel: 'test' },
      });
      ids.push(
        (
          await prisma.player.create({
            data: {
              gameId,
              agentId: agent.id,
              seatNo,
              displayName: '玩家' + seatNo,
              modelName: 'mock',
              memoryLabelSnapshot: 'test',
            },
          })
        ).id,
      );
    }
    [actorId, secondId] = ids;
    recovery = new GameRecoveryService(prisma);
    writer = new EventWriterService(prisma, recovery);
    broadcaster = new SseBroadcasterService();
    bus = new EventBusService(prisma, broadcaster);
    messages = [];
    broadcaster.getOrCreate(gameId).subscribe((message) => messages.push(message));
  });
  afterEach(async () => {
    await bus.onModuleDestroy();
    broadcaster.complete(gameId);
    jest.restoreAllMocks();
  });

  const speech = (phaseInstanceId = 'node/2/speech', content = '完整发言') => ({
    gameId,
    phaseInstanceId,
    actorId,
    seatNo: 1,
    day: 1,
    content,
    thinking: '完整思考',
    sceneId: phaseInstanceId + '/' + actorId,
  });
  const vote = () => ({
    gameId,
    phaseInstanceId: 'node/3/vote',
    day: 1,
    expectedActorIds: [actorId, secondId],
    votes: [
      { actorId, voterSeatNo: 1, targetSeatNo: 2 },
      { actorId: secondId, voterSeatNo: 2, targetSeatNo: 0 },
    ],
  });
  const deliveries = () =>
    prisma.eventDeliveryOutbox.findMany({ where: { gameId }, orderBy: { firstSequence: 'asc' } });

  it.each([false, true])(
    '并发与检查点复用只创建一份意图，内容冲突保持原记录（恢复=%s）',
    async (recoverable) => {
      const execution = recoverable
        ? await recovery.create(
            gameId,
            {},
            { version: 1, prompts: {} },
            new Date(Date.now() + 60_000),
          )
        : undefined;
      const run = <T>(action: () => Promise<T>) =>
        execution ? recovery.run(execution, new AbortController().signal, action) : action();
      const [first, same] = await run(() =>
        Promise.all([
          writer.writePlayerSpeechEvent(speech()),
          writer.writePlayerSpeechEvent(speech()),
        ]),
      );
      expect(first.id).toBe(same.id);
      const before = await deliveries();
      expect(before).toHaveLength(1);
      await run(() => writer.writePlayerSpeechEvent(speech()));
      await expect(
        run(() => writer.writePlayerSpeechEvent(speech(undefined, '另一内容'))),
      ).rejects.toThrow('冲突');
      expect(await deliveries()).toEqual(before);
    },
  );

  it('同日不同节点轮次各有独立场景、Event 与交付记录', async () => {
    const first = await writer.writePlayerSpeechEvent(speech('node/2/pkSpeech'));
    const second = await writer.writePlayerSpeechEvent(speech('node/4/pkSpeech'));
    expect(first.id).not.toBe(second.id);
    expect(await deliveries()).toHaveLength(2);
  });

  it('整批重试返回原 ID，批次只发送一个完整最终消息', async () => {
    const first = await writer.writeVoteBatch(vote());
    const repeated = await writer.writeVoteBatch(vote());
    expect(repeated.map((event) => event.id)).toEqual(first.map((event) => event.id));
    expect(await deliveries()).toHaveLength(1);
    await bus.dispatchPending();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'events.committed',
      scenes: [
        expect.objectContaining({ eventId: first[0].id }),
        expect.objectContaining({ eventId: first[1].id }),
      ],
    });
  });

  it.each(['events', 'event_delivery_outbox'])(
    '批内事件或交付意图写入失败，整批全部回滚（%s）',
    async (table) => {
      const constraint = table === 'events' ? 'sequence <> 2' : 'false';
      await prisma.$executeRawUnsafe(
        `ALTER TABLE ${table} ADD CONSTRAINT delivery_reject CHECK (${constraint}) NOT VALID`,
      );
      try {
        await expect(writer.writeVoteBatch(vote())).rejects.toThrow('delivery_reject');
        expect(await prisma.event.count({ where: { gameId } })).toBe(0);
        expect(await prisma.effectBatchCommit.count({ where: { gameId } })).toBe(0);
        expect(await deliveries()).toHaveLength(0);
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE ${table} DROP CONSTRAINT delivery_reject`);
      }
    },
  );

  it('批次冲突和空批次均不制造空消息，合法弃票仍可交付', async () => {
    const empty = { ...vote(), expectedActorIds: [], votes: [] };
    await writer.writeVoteBatch(empty);
    await writer.writeVoteBatch(empty);
    await expect(writer.writeVoteBatch(vote())).rejects.toThrow('冲突');
    expect(await deliveries()).toHaveLength(0);
    expect(await prisma.effectBatchCommit.count({ where: { gameId } })).toBe(1);
    await writer.writeVoteBatch({ ...vote(), phaseInstanceId: 'node/5/vote' });
    await bus.dispatchPending();
    expect(messages[0]).toMatchObject({
      scenes: expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ targetSeatNo: 0 }) }),
      ]),
    });
  });

  it.each([false, true])(
    '提交响应丢失后重试保留同一 Event 和意图（恢复=%s）',
    async (recoverable) => {
      const execution = recoverable
        ? await recovery.create(
            gameId,
            {},
            { version: 1, prompts: {} },
            new Date(Date.now() + 60_000),
          )
        : undefined;
      const run = <T>(action: () => Promise<T>) =>
        execution ? recovery.run(execution, new AbortController().signal, action) : action();
      const transact = prisma.$transaction.bind(prisma);
      const lost = jest.spyOn(prisma, '$transaction').mockImplementationOnce((async (
        action: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        await transact(action);
        throw new Error('提交响应丢失');
      }) as never);
      await expect(run(() => writer.writeVoteBatch(vote()))).rejects.toThrow('提交响应丢失');
      lost.mockRestore();
      const original = await deliveries();
      const replay = await run(() => writer.writeVoteBatch(vote()));
      expect(replay.map((event) => event.id)).toEqual(original[0].eventIds);
      expect(await deliveries()).toEqual(original);
    },
  );

  it('派发进程在提交后重启，不依赖节点再次发布便能取回原结果', async () => {
    const event = await writer.writePlayerSpeechEvent(speech());
    const restarted = new EventBusService(prisma, broadcaster);
    await restarted.dispatchPending();
    expect(messages[0]).toMatchObject({
      type: 'events.committed',
      scenes: [expect.objectContaining({ eventId: event.id })],
    });
    expect((await deliveries())[0].deliveredAt).not.toBeNull();
  });

  it('发送成功但确认写入失败时可重投，不新增业务事实', async () => {
    const event = await writer.writePlayerSpeechEvent(speech());
    const failure = jest
      .spyOn(prisma.eventDeliveryOutbox, 'updateMany')
      .mockRejectedValueOnce(new Error('发送后确认丢失'));
    await bus.dispatchPending();
    failure.mockRestore();
    await prisma.eventDeliveryOutbox.updateMany({
      where: { gameId },
      data: { nextAttemptAt: new Date(0) },
    });
    await bus.dispatchPending();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ scenes: [expect.objectContaining({ eventId: event.id })] });
    expect(messages[1]).toMatchObject({ scenes: [expect.objectContaining({ eventId: event.id })] });
    expect(await prisma.event.count({ where: { gameId } })).toBe(1);
  });

  it('同局前项失败不越序，其他局可继续；不可展示事件不阻塞后续', async () => {
    const first = await writer.writePlayerSpeechEvent(speech());
    const second = await writer.writePlayerSpeechEvent(speech('node/4/speech'));
    const otherGame = await prisma.game.create({
      data: { rulesetId: 'delivery', skillVersion: 'test', status: 'running' },
    });
    await writer.writeJudgeEvent({
      gameId: otherGame.id,
      phaseInstanceId: 'node/1/judge',
      day: 1,
      content: '另一局',
    });
    const emit = broadcaster.emitCommitted.bind(broadcaster);
    const failure = jest.spyOn(broadcaster, 'emitCommitted').mockImplementation((id, message) => {
      if (id === gameId) throw new Error('本局交付暂时不可用');
      return emit(id, message);
    });
    await bus.dispatchPending();
    expect((await deliveries()).map((item) => item.attempts)).toEqual([1, 0]);
    expect(
      (await prisma.eventDeliveryOutbox.findFirst({ where: { gameId: otherGame.id } }))
        ?.deliveredAt,
    ).not.toBeNull();
    failure.mockRestore();
    await prisma.eventDeliveryOutbox.updateMany({
      where: { gameId },
      data: { nextAttemptAt: new Date(0) },
    });
    await bus.dispatchPending();
    await bus.dispatchPending();
    expect(
      messages.map((message) =>
        message.type === 'events.committed' ? message.scenes[0].eventId : null,
      ),
    ).toEqual([first.id, second.id]);
    await writer.commitNightResolution({
      gameId,
      phaseInstanceId: 'node/5/nightResolve',
      day: 1,
      deaths: [],
    });
    await bus.dispatchPending();
    expect(messages.at(-1)).toMatchObject({ scenes: [], playerDeaths: [] });
    expect((await deliveries()).every((item) => item.deliveredAt)).toBe(true);
  });

  it('交付达到重试上限后放弃该批，不再阻塞同局后续交付', async () => {
    await writer.writePlayerSpeechEvent(speech());
    const second = await writer.writePlayerSpeechEvent(speech('node/4/speech'));
    const [stuck] = await deliveries();
    await prisma.eventDeliveryOutbox.updateMany({
      where: { deliveryKey: stuck.deliveryKey },
      data: { attempts: 9 },
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    const failure = jest.spyOn(broadcaster, 'emitCommitted').mockImplementation(() => {
      throw new Error('广播持续不可用');
    });
    await bus.dispatchPending();
    failure.mockRestore();
    expect(messages).toHaveLength(0);
    expect((await deliveries())[0]).toMatchObject({ attempts: 10, deliveredAt: null });
    await bus.dispatchPending();
    expect(
      messages.map((message) =>
        message.type === 'events.committed' ? message.scenes[0].eventId : null,
      ),
    ).toEqual([second.id]);
    expect(await bus.dispatchPending()).toBe(0);
  });

  it('两个派发器并发只领取一次，租约到期可重新领取', async () => {
    await writer.writePlayerSpeechEvent(speech());
    const competitor = new EventBusService(prisma, broadcaster);
    await Promise.all([bus.dispatchPending(), competitor.dispatchPending()]);
    expect(messages).toHaveLength(1);
    await writer.writePlayerSpeechEvent(speech('node/5/speech'));
    await prisma.eventDeliveryOutbox.updateMany({
      where: { gameId, deliveredAt: null },
      data: {
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 30_000),
      },
    });
    expect(await bus.dispatchPending()).toBe(0);
    await prisma.eventDeliveryOutbox.updateMany({
      where: { gameId, deliveredAt: null },
      data: { leaseUntil: new Date(0) },
    });
    expect(await competitor.dispatchPending()).toBe(1);
    expect(messages).toHaveLength(2);
  });

  it('领取已过期的派发者不能回写新消费者的确认状态', async () => {
    await writer.writePlayerSpeechEvent(speech());
    const update = prisma.eventDeliveryOutbox.updateMany.bind(prisma.eventDeliveryOutbox);
    const newToken = randomUUID();
    const injected = jest
      .spyOn(prisma.eventDeliveryOutbox, 'updateMany')
      .mockImplementationOnce((async (args: Prisma.EventDeliveryOutboxUpdateManyArgs) => {
        await update({ where: { gameId }, data: { leaseToken: newToken } });
        return update(args);
      }) as never);
    await bus.dispatchPending();
    injected.mockRestore();
    expect((await deliveries())[0]).toMatchObject({ leaseToken: newToken, deliveredAt: null });
  });

  it('无内存流或无观众时，重连从数据库读取已提交内容', async () => {
    const event = await writer.writePlayerSpeechEvent(speech());
    broadcaster.complete(gameId);
    await bus.dispatchPending();
    expect((await deliveries())[0].deliveredAt).not.toBeNull();
    const ready = await firstValueFrom(
      broadcaster.getRecoveryStream(gameId, () => bus.loadSnapshot(gameId)),
    );
    expect(ready).toMatchObject({
      type: 'connection.ready',
      snapshot: [expect.objectContaining({ eventId: event.id, content: '完整发言' })],
    });
  });

  it('自爆死亡保存于交付记录，不从公告文字或后续玩家状态猜测', async () => {
    await writer.writeJudgeEvent({
      gameId,
      phaseInstanceId: 'node/5/wolfExplode',
      day: 1,
      content: '自爆公告',
      death: { playerId: actorId, cause: 'self_destruct' },
    });
    expect((await deliveries())[0].playerDeaths).toEqual([
      { playerId: actorId, deathDay: 1, deathCause: 'self_destruct' },
    ]);
    await bus.dispatchPending();
    expect(messages[0]).toMatchObject({
      playerDeaths: [{ playerId: actorId, deathDay: 1, deathCause: 'self_destruct' }],
    });
  });

  it('终局在前序完整交付后关闭，刷新仍返回全部发言和胜负', async () => {
    await writer.writePlayerSpeechEvent(speech());
    await writer.writeGameEndEvent({
      gameId,
      phaseInstanceId: 'node/9/gameEnd',
      winner: 'villager',
      winnerFaction: 'villager',
      totalDays: 1,
    });
    await bus.dispatchPending();
    expect(broadcaster.exists(gameId)).toBe(true);
    await bus.dispatchPending();
    expect(messages.at(-1)).toMatchObject({
      type: 'events.committed',
      gameFinished: { winner: 'villager' },
    });
    expect(broadcaster.exists(gameId)).toBe(false);
    const ready = await firstValueFrom(
      broadcaster.getRecoveryStream(gameId, () => bus.loadSnapshot(gameId)),
    );
    expect(ready).toMatchObject({
      snapshot: expect.arrayContaining([expect.objectContaining({ content: '完整发言' })]),
      gameStatus: 'finished',
      gameFinished: { winner: 'villager' },
    });
  });

  it.each(['pending_recovery', 'aborted'])(
    '非规则终局状态按数据库读取，不创建假 Event（%s）',
    async (status) => {
      await writer.writePlayerSpeechEvent(speech());
      await prisma.game.update({ where: { id: gameId }, data: { status } });
      const snapshot = await bus.loadSnapshot(gameId);
      expect(snapshot.gameStatus).toBe(status);
      expect(snapshot.gameFinished).toEqual(
        status === 'aborted' ? { winner: 'unknown' } : undefined,
      );
      expect(await prisma.event.count({ where: { gameId } })).toBe(1);
    },
  );

  it('历史 PK 场景重名时保留两条 Event，不推测回填历史业务键', async () => {
    for (const sequence of [1, 2]) {
      await prisma.event.create({
        data: {
          gameId,
          sequence,
          day: 1,
          phase: 'speech',
          actionType: 'speech',
          content: { sceneId: '旧的相同场景', speech: '第' + sequence + '轮' },
        },
      });
    }
    const snapshot = await bus.loadSnapshot(gameId);
    expect(snapshot.snapshot).toHaveLength(2);
    expect(new Set(snapshot.snapshot.map((scene) => scene.eventId)).size).toBe(2);
    expect(await deliveries()).toHaveLength(0);
  });
});

describe('交付迁移兼容历史数据', () => {
  it('Prisma 生成迁移保留既有事件和业务键，不回填交付记录', async () => {
    const id = randomUUID();
    let database: Awaited<ReturnType<typeof createLearningTestDatabase>> | undefined;
    try {
      database = await createLearningTestDatabase({
        beforeMigration: {
          name: '20260914052035_event_delivery_outbox',
          run: async (client) => {
            await client.query(
              `INSERT INTO rulesets(id,name,player_count,definition) VALUES ('old-delivery','历史',1,'{}')`,
            );
            await client.query(
              `INSERT INTO games(id,ruleset_id,skill_version,status) VALUES ($1,'old-delivery','v1','finished')`,
              [id],
            );
            await client.query(
              `INSERT INTO events(id,game_id,sequence,phase,action_type,content,effect_key,payload_hash)
            VALUES ($1,$2,1,'speech','speech','{"speech":"历史内容"}','原业务键',$3)`,
              [randomUUID(), id, 'a'.repeat(64)],
            );
          },
        },
      });
      expect(await database.db.event.findFirst({ where: { gameId: id } })).toMatchObject({
        content: { speech: '历史内容' },
        effectKey: '原业务键',
        payloadHash: 'a'.repeat(64),
      });
      expect(await database.db.eventDeliveryOutbox.count()).toBe(0);
      await database.runPrisma(
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      );
    } finally {
      await database?.close();
    }
  });
});

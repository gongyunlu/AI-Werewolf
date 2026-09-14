import { Injectable, Optional } from '@nestjs/common';
import { GameRecoveryService } from '@/game-recovery/game-recovery.service';
import { PrismaService } from '@/prisma/prisma.service';
import { type Prisma, type Event } from '@/generated/prisma/client';
import {
  ACTION_TYPES,
  GAME_STATUSES,
  VISIBILITY_TYPES,
  PHASES,
  DEATH_CAUSES,
  type DeathCause,
  type SeerCheckResult,
} from '@ai-werewolf/shared';
import { RedisService } from '@/redis/redis.service';

/** 判断是否为 Prisma 唯一约束冲突（P2002） */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Event 写入服务
 *
 * 负责事件落库，广播由节点层调用 EventBusService 处理
 */
@Injectable()
export class EventWriterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {}

  /** 夜间结算与全部死亡状态同事务；即使当夜终局也保留内部结算事实。 */
  async commitNightResolution(options: {
    gameId: string;
    day: number;
    deaths: Array<{ playerId: string; seatNo: number; cause: DeathCause }>;
  }): Promise<Event> {
    return this.createEventWithSequence(
      options.gameId,
      {
        day: options.day,
        phase: PHASES.NIGHT,
        actionType: ACTION_TYPES.NIGHT_RESOLVED,
        visibility: VISIBILITY_TYPES.SYSTEM,
        actorId: null,
        targetIds: options.deaths.map((death) => death.playerId),
        content: { deaths: options.deaths },
      },
      async (tx) => {
        for (const death of options.deaths) {
          await tx.player.update({
            where: { id: death.playerId, gameId: options.gameId },
            data: { deathDay: options.day, deathCause: death.cause },
          });
        }
      },
    );
  }

  /**
   * 写入预言家查验事件
   */
  async writeWolfDecisionEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    actionType: 'wolf_explode' | 'wolf_proposal';
    content: Prisma.InputJsonObject;
  }): Promise<Event> {
    return this.createEventWithSequence(options.gameId, {
      day: options.day,
      phase: options.actionType === 'wolf_explode' ? PHASES.DAY_ANNOUNCE : PHASES.NIGHT,
      actionType: options.actionType,
      visibility: VISIBILITY_TYPES.WOLF,
      actorId: options.actorId,
      targetIds: [],
      content: options.content,
    });
  }

  async writeSeerCheckEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    targetSeatNo: number;
    result: SeerCheckResult;
    thinking?: string;
  }): Promise<Event> {
    const { gameId, day, actorId, targetSeatNo, result, thinking } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.SEER_CHECK,
      visibility: VISIBILITY_TYPES.SEER,
      actorId,
      targetIds: [],
      content: {
        targetSeatNo,
        result,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入狼人刀人事件
   */
  async writeWolfKillEvent(options: {
    gameId: string;
    day: number;
    targetId?: string | null;
    targetSeatNo?: number;
    proposalEventIds?: string[];
  }): Promise<Event> {
    const { gameId, day, targetId, targetSeatNo } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WOLF_KILL,
      visibility: VISIBILITY_TYPES.WOLF_KILL, // 狼人 + 未用解药的女巫可见
      actorId: null, // 狼队集体决策，没有单一 actor
      targetIds: targetId ? [targetId] : [], // 空刀时为空数组
      content: {
        targetSeatNo,
        cause: 'night_kill',
        proposalEventIds: options.proposalEventIds ?? [],
      },
    });

    return event;
  }

  /**
   * 写入女巫解药事件
   */
  async writeWitchAntidoteEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    targetId: string;
    targetSeatNo: number;
    thinking?: string;
  }): Promise<Event> {
    const { gameId, day, actorId, targetId, targetSeatNo, thinking } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WITCH_SAVE,
      visibility: VISIBILITY_TYPES.WITCH,
      actorId,
      targetIds: targetSeatNo !== 0 ? [targetId] : [],
      content: {
        targetSeatNo,
        saved: targetSeatNo !== 0,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入女巫毒药事件
   */
  async writeWitchPoisonEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    targetId: string;
    targetSeatNo: number;
    thinking?: string;
  }): Promise<Event> {
    const { gameId, day, actorId, targetId, targetSeatNo, thinking } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WITCH_POISON,
      visibility: VISIBILITY_TYPES.WITCH,
      actorId,
      targetIds: targetSeatNo !== 0 ? [targetId] : [],
      content: {
        targetSeatNo,
        used: targetSeatNo !== 0,
        cause: targetSeatNo !== 0 ? 'witch_poison' : null,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入死亡公告事件
   */
  async writeDeathAnnouncementEvent(options: {
    gameId: string;
    day: number;
    deaths: Array<{ playerId: string; seatNo: number; cause: string }>;
  }): Promise<Event> {
    const { gameId, day, deaths } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.DAY_ANNOUNCE,
      actionType: ACTION_TYPES.PLAYER_DIED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: deaths.map((d) => d.playerId),
      content: {
        deaths: deaths.map((d) => ({
          seatNo: d.seatNo,
          cause: d.cause,
        })),
      },
    });

    return event;
  }

  /**
   * 写入平安夜事件
   */
  async writePeacefulNightEvent(options: { gameId: string; day: number }): Promise<Event> {
    const { gameId, day } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.DAY_ANNOUNCE,
      actionType: ACTION_TYPES.PEACEFUL_NIGHT,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: {
        message: '昨晚是平安夜',
      },
    });

    return event;
  }

  /**
   * 写入玩家发言事件（白天公开发言）
   */
  async writePlayerSpeechEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    seatNo: number;
    content: string;
    thinking?: string; // AI 的推理过程
    sceneId?: string;
    sceneType?: 'speech' | 'last_words';
    /** 保留实际发言窗口与轮次，避免历史 PK、遗言被当成普通发言。 */
    turn?: { phase: string; round: number };
  }): Promise<Event> {
    const { gameId, day, actorId, seatNo, content, thinking } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SPEECH,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId,
      targetIds: [],
      content: {
        seatNo,
        speech: content,
        thinking,
        sceneId: options.sceneId,
        sceneType: options.sceneType,
        turn: options.turn,
      },
    });

    return event;
  }

  /**
   * 写入狼人夜间讨论事件（仅狼队可见）
   */
  async writeWolfDiscussionEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    seatNo: number;
    content: string;
    round: number; // 讨论轮次
    thinking?: string;
    sceneId?: string;
  }): Promise<Event> {
    const { gameId, day, actorId, seatNo, content, round, thinking } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.SPEECH,
      visibility: VISIBILITY_TYPES.WOLF,
      actorId,
      targetIds: [],
      content: {
        seatNo,
        speech: content,
        round,
        thinking,
        sceneId: options.sceneId,
        sceneType: 'night_action',
      },
    });

    return event;
  }

  /**
   * 写入玩家投票事件
   */
  async writePlayerVoteEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    voterSeatNo: number;
    targetSeatNo: number;
    voteRound?: number;
    thinking?: string;
  }): Promise<Event> {
    const { gameId, day, actorId, voterSeatNo, targetSeatNo } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.VOTE,
      actionType: ACTION_TYPES.VOTE,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId,
      targetIds: [],
      content: {
        voteRound: options.voteRound ?? 0,
        voterSeatNo,
        targetSeatNo,
        thinking: options.thinking,
      },
    });

    return event;
  }

  /**
   * 原子提交放逐事件与玩家死亡状态
   */
  async commitExile(options: {
    gameId: string;
    day: number;
    targetId: string;
    targetSeatNo: number;
    voteCount: number;
  }): Promise<Event> {
    const { gameId, day, targetId, targetSeatNo, voteCount } = options;

    const event = await this.createEventWithSequence(
      gameId,
      {
        day,
        phase: PHASES.EXECUTE,
        actionType: ACTION_TYPES.PLAYER_EXECUTED,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [targetId],
        content: {
          targetSeatNo,
          voteCount,
          message: `${targetSeatNo}号位被放逐出局`,
        },
      },
      async (tx) => {
        await tx.player.update({
          where: { id: targetId, gameId },
          data: { deathDay: day, deathCause: DEATH_CAUSES.EXECUTION },
        });
      },
    );

    return event;
  }

  /**
   * 写入白痴翻牌事件
   */
  async writeIdiotRevealEvent(options: {
    gameId: string;
    day: number;
    playerId: string;
    seatNo: number;
  }): Promise<Event> {
    const { gameId, day, playerId, seatNo } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.EXECUTE,
      actionType: ACTION_TYPES.IDIOT_FLIP,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: playerId,
      targetIds: [],
      content: {
        seatNo,
        message: `${seatNo}号位白痴翻牌，免疫死亡`,
      },
    });

    return event;
  }

  /**
   * 写入警长决定发言顺序事件
   */
  async writeSheriffDecideOrderEvent(options: {
    gameId: string;
    day: number;
    sheriffId: string;
    sheriffSeatNo: number;
    direction: 'left' | 'right';
  }): Promise<Event> {
    const { gameId, day, sheriffId, sheriffSeatNo, direction } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: sheriffId,
      targetIds: [],
      content: {
        sheriffSeatNo,
        direction,
        message: `警长${sheriffSeatNo}号位决定从${direction === 'left' ? '左手' : '右手'}开始发言（${direction === 'left' ? '逆时针' : '顺时针'}）`,
      },
    });

    return event;
  }

  /**
   * 写入发言顺序确定事件（无警长或自动计算）
   */
  async writeSpeechOrderDeterminedEvent(options: {
    gameId: string;
    day: number;
    speechOrder: number[];
    startSeatNo: number;
    direction: 'clockwise' | 'counterclockwise';
    reason: string;
  }): Promise<Event> {
    const { gameId, day, speechOrder, startSeatNo, direction, reason } = options;

    const event = await this.createEventWithSequence(gameId, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SPEECH_ORDER_DETERMINED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: {
        speechOrder,
        startSeatNo,
        direction,
        reason,
        message: `今天的发言顺序: ${speechOrder.join(' → ')}`,
      },
    });

    return event;
  }

  /** 游戏开始系统事件 */
  async writeGameStartEvent(params: { gameId: string; playerCount: number }): Promise<Event> {
    return this.createEventWithSequence(params.gameId, {
      day: 0,
      phase: PHASES.SYSTEM,
      actionType: ACTION_TYPES.GAME_STARTED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { playerCount: params.playerCount },
    });
  }

  /**
   * 原子写入一轮普通投票的全部事件。
   *
   * 同一批投票要么全部落库，要么全部不落库；批次内不产生可观察的中间状态。
   * 目前只有普通投票使用；PK 与狼队投票仍是逐票提交，尚未接入。
   */
  async writeVoteBatch(options: {
    gameId: string;
    day: number;
    votes: Array<{
      actorId: string;
      voterSeatNo: number;
      targetSeatNo: number;
      voteRound?: number;
      thinking?: string;
    }>;
  }): Promise<Event[]> {
    return this.createEventBatch(
      options.gameId,
      options.votes.map((vote) => ({
        day: options.day,
        phase: PHASES.VOTE,
        actionType: ACTION_TYPES.VOTE,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: vote.actorId,
        targetIds: [],
        content: {
          voteRound: vote.voteRound ?? 0,
          voterSeatNo: vote.voterSeatNo,
          targetSeatNo: vote.targetSeatNo,
          thinking: vote.thinking,
        },
      })),
    );
  }

  /**
   * 原子持久化游戏结束事件与 FINISHED 状态。
   *
   * 两项终局事实必须在同一事务提交：既不能出现 FINISHED 却缺结束事件，也不能留下
   * GAME_ENDED 事件但对局随后被当成引擎失败标记为 ABORTED。Redis sequence 只负责分配
   * 序号；事务回滚产生的序号空洞是允许的。
   */
  async writeGameEndEvent(params: {
    gameId: string;
    winner: string;
    winnerFaction: string | null;
    totalDays: number;
    endedAt?: Date;
  }): Promise<Event> {
    if (this.recovery?.current) {
      return this.recovery.effect('game-end', async (tx) => {
        const previous = await tx.event.findFirst({
          where: { gameId: params.gameId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const event = await tx.event.create({
          data: {
            gameId: params.gameId,
            sequence: (previous?.sequence ?? 0) + 1,
            day: 0,
            phase: PHASES.SYSTEM,
            actionType: ACTION_TYPES.GAME_ENDED,
            visibility: VISIBILITY_TYPES.PUBLIC,
            content: { winner: params.winner },
          },
        });
        await tx.game.update({
          where: { id: params.gameId },
          data: {
            status: GAME_STATUSES.FINISHED,
            winnerFaction: params.winnerFaction,
            totalDays: params.totalDays,
            endedAt: params.endedAt ?? new Date(),
          },
        });
        return event;
      });
    }
    const key = `game:${params.gameId}:event_seq`;
    const persist = (sequence: number) =>
      this.prisma.$transaction(async (tx) => {
        const event = await tx.event.create({
          data: {
            gameId: params.gameId,
            sequence,
            day: 0,
            phase: PHASES.SYSTEM,
            actionType: ACTION_TYPES.GAME_ENDED,
            visibility: VISIBILITY_TYPES.PUBLIC,
            actorId: null,
            targetIds: [],
            content: { winner: params.winner },
          },
        });

        await tx.game.update({
          where: { id: params.gameId },
          data: {
            status: GAME_STATUSES.FINISHED,
            winnerFaction: params.winnerFaction ?? undefined,
            totalDays: params.totalDays,
            endedAt: params.endedAt ?? new Date(),
          },
        });

        return event;
      });

    const sequence = await this.redis.incr(key);
    try {
      return await persist(sequence);
    } catch (error) {
      // 事务已整体回滚，因而可以在事务外重建 Redis 计数器并安全地重试整笔终局写入。
      if (!isUniqueConstraintViolation(error)) throw error;

      const lastEvent = await this.prisma.event.findFirst({
        where: { gameId: params.gameId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await this.redis.set(key, lastEvent?.sequence || 0);
      return persist(await this.redis.incr(key));
    }
  }

  /** 法官播报事件（公开）；可与该播报宣告的状态变更同事务提交。 */
  async writeJudgeEvent(params: {
    gameId: string;
    day: number;
    content: string;
    metadata?: Record<string, unknown>;
    updateState?: (tx: Prisma.TransactionClient) => Promise<void>;
  }): Promise<Event> {
    return this.createEventWithSequence(
      params.gameId,
      {
        day: params.day,
        phase: PHASES.JUDGE,
        actionType: ACTION_TYPES.JUDGE_ANNOUNCE,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { content: params.content, ...params.metadata } as Prisma.InputJsonValue,
      },
      params.updateState,
    );
  }

  /** 夜间法官引导事件 */
  async writeNightPromptEvent(params: {
    gameId: string;
    day: number;
    content: string;
    targetRole: string;
  }): Promise<Event> {
    return this.createEventWithSequence(params.gameId, {
      day: params.day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.NIGHT_PROMPT,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { content: params.content, targetRole: params.targetRole },
    });
  }

  /**
   * 初始化游戏的 Redis sequence 计数器
   *
   * 从数据库读取该游戏的最大 sequence，初始化 Redis 计数器。
   * 使用 SET NX 确保只在计数器不存在时初始化，避免覆盖正在运行的游戏的计数器。
   *
   * @param gameId - 游戏对局ID
   */
  async initializeSequenceCounter(gameId: string): Promise<void> {
    const key = `game:${gameId}:event_seq`;
    const exists = await this.redis.exists(key);

    // 如果计数器已存在，说明游戏正在运行或刚运行过，不需要初始化
    if (exists) {
      return;
    }

    // 从数据库读取最大 sequence
    const lastEvent = await this.prisma.event.findFirst({
      where: { gameId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    const maxSequence = lastEvent?.sequence || 0;

    // 使用 SET NX 原子地初始化计数器（仅当 key 不存在时设置）
    // 避免并发初始化覆盖问题
    await this.redis.set(key, maxSequence, 'NX');
  }

  /**
   * 原子分配整段 sequence 并写入一批事件。
   *
   * 与单项写入共享同一套序号来源与冲突兜底，区别只在于整批共用一个事务。
   */
  private async createEventBatch(
    gameId: string,
    drafts: Array<Omit<Prisma.EventUncheckedCreateInput, 'gameId' | 'sequence'>>,
  ): Promise<Event[]> {
    if (drafts.length === 0) return [];
    // 事务内顺序写：同一连接本来不并行，串行还能让失败原因指向具体那一条。
    const write = async (tx: Prisma.TransactionClient, first: number) => {
      const events: Event[] = [];
      for (const [index, data] of drafts.entries())
        events.push(await tx.event.create({ data: { ...data, gameId, sequence: first + index } }));
      return events;
    };
    if (this.recovery?.current) {
      return this.recovery.effect(
        `event-batch/${drafts[0].actionType}/${drafts[0].actorId ?? 'system'}`,
        async (tx) => {
          const previous = await tx.event.findFirst({
            where: { gameId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });
          return write(tx, (previous?.sequence ?? 0) + 1);
        },
      );
    }
    const key = `game:${gameId}:event_seq`;
    const last = await this.redis.incrby(key, drafts.length);
    try {
      return await this.prisma.$transaction((tx) => write(tx, last - drafts.length + 1));
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      const previous = await this.prisma.event.findFirst({
        where: { gameId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await this.redis.set(key, previous?.sequence || 0);
      const retryLast = await this.redis.incrby(key, drafts.length);
      return this.prisma.$transaction((tx) => write(tx, retryLast - drafts.length + 1));
    }
  }

  /**
   * 原子分配 sequence 并写入事件
   *
   * 使用 Redis INCR 原子递增生成 sequence，避免并发冲突和重试开销。
   * 前提：Redis 需开持久化（AOF/RDB），sequence 计数器依赖 key 不因重启丢失；
   * 若对局中途 Redis 重启导致计数器与 DB 失同步，下方 P2002 兜底会重建计数器后重试一次。
   */
  private async createEventWithSequence(
    gameId: string,
    data: Omit<Prisma.EventUncheckedCreateInput, 'gameId' | 'sequence'>,
    updateState?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<Event> {
    const write = async (tx: Prisma.TransactionClient, sequence: number) => {
      const event = await tx.event.create({ data: { ...data, gameId, sequence } });
      await updateState?.(tx);
      return event;
    };
    if (this.recovery?.current) {
      return this.recovery.effect(
        `event/${data.actionType}/${data.actorId ?? 'system'}`,
        async (tx) => {
          const previous = await tx.event.findFirst({
            where: { gameId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });
          return write(tx, (previous?.sequence ?? 0) + 1);
        },
      );
    }
    const persist = (sequence: number) =>
      updateState
        ? this.prisma.$transaction((tx) => write(tx, sequence))
        : write(this.prisma, sequence);
    const key = `game:${gameId}:event_seq`;
    const sequence = await this.redis.incr(key);

    try {
      return await persist(sequence);
    } catch (error) {
      // Redis 计数器与 DB 失同步（典型：对局中途 Redis 重启导致计数器归零）→ 撞 @@unique([gameId, sequence])。
      // 从 DB 读最大 sequence 重建计数器后重试一次。事件溯源允许序列空洞，仅兜底唯一约束冲突。
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      const lastEvent = await this.prisma.event.findFirst({
        where: { gameId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      await this.redis.set(key, lastEvent?.sequence || 0);
      const nextSequence = await this.redis.incr(key);
      return persist(nextSequence);
    }
  }
}

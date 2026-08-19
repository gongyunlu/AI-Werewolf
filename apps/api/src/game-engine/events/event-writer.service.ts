import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { type Prisma, type Event } from '@/generated/prisma/client';
import { ACTION_TYPES, VISIBILITY_TYPES, PHASES, type SeerCheckResult } from '@ai-werewolf/shared';

/** sequence 冲突时的最大重试次数 */
const MAX_SEQUENCE_RETRY = 10;

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
 * Event 写入服务（纯持久化仓储）
 *
 * 只负责将游戏事件写入 Event 表；广播由节点层在写入后显式调用 EventBusService.publish 发起，
 * 落库与广播职责解耦（流式场景无需广播，避免同一段发言出现两张卡片）。
 */
@Injectable()
export class EventWriterService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 写入预言家查验事件
   */
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
      targetIds: [targetId],
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
      targetIds: [targetId],
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
        voterSeatNo,
        targetSeatNo,
      },
    });

    return event;
  }

  /**
   * 写入放逐执行事件
   */
  async writePlayerExiledEvent(options: {
    gameId: string;
    day: number;
    targetId: string;
    targetSeatNo: number;
    voteCount: number;
  }): Promise<Event> {
    const { gameId, day, targetId, targetSeatNo, voteCount } = options;

    const event = await this.createEventWithSequence(gameId, {
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
    });

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

  /** 游戏结束系统事件 */
  async writeGameEndEvent(params: { gameId: string; winner: string }): Promise<Event> {
    return this.createEventWithSequence(params.gameId, {
      day: 0,
      phase: PHASES.SYSTEM,
      actionType: ACTION_TYPES.GAME_ENDED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { winner: params.winner },
    });
  }

  /** 法官播报事件（公开） */
  async writeJudgeEvent(params: {
    gameId: string;
    day: number;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Event> {
    return this.createEventWithSequence(params.gameId, {
      day: params.day,
      phase: PHASES.JUDGE,
      actionType: ACTION_TYPES.JUDGE_ANNOUNCE,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { content: params.content, ...params.metadata } as Prisma.InputJsonValue,
    });
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
   * 原子分配 sequence 并写入事件
   *
   * sequence 的「读最大值 + 1」与事件写入必须原子，否则并发写入（如投票节点 Promise.all 并行投票）会读到同一
   * lastSequence、算出重复 sequence，撞 @@unique([gameId, sequence])。这里把两步放进同一事务，冲突时乐观重试。
   */
  private async createEventWithSequence(
    gameId: string,
    data: Omit<Prisma.EventUncheckedCreateInput, 'gameId' | 'sequence'>,
  ): Promise<Event> {
    for (let attempt = 0; ; attempt++) {
      try {
        const event = await this.prisma.$transaction(async (tx) => {
          const lastEvent = await tx.event.findFirst({
            where: { gameId },
            orderBy: { sequence: 'desc' },
            select: { sequence: true },
          });

          const sequence = (lastEvent?.sequence || 0) + 1;

          return tx.event.create({
            data: { ...data, gameId, sequence },
          });
        });

        return event;
      } catch (error) {
        if (!isUniqueConstraintViolation(error) || attempt >= MAX_SEQUENCE_RETRY) {
          throw error;
        }
      }
    }
  }
}

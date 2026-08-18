import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { type Prisma } from '@/generated/prisma/client';
import { ACTION_TYPES, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import { EventBusService } from '@/event-bus/event-bus.service';

/**
 * Event 写入服务
 *
 * 负责将游戏事件写入 Event 表并通过 EventBus 广播
 */
@Injectable()
export class EventWriterService {
  private readonly logger = new Logger(EventWriterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventBus: EventBusService,
  ) {}

  /**
   * 写入预言家查验事件
   */
  async writeSeerCheckEvent(options: {
    gameId: string;
    day: number;
    actorId: string;
    targetSeatNo: number;
    result: 'good' | 'werewolf';
    thinking?: string;
  }): Promise<void> {
    const { gameId, day, actorId, targetSeatNo, result, thinking } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'night',
        actionType: ACTION_TYPES.SEER_CHECK,
        visibility: VISIBILITY_TYPES.SEER,
        actorId,
        targetIds: [],
        content: {
          targetSeatNo,
          result,
          thinking,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入预言家查验: Day ${day}, ${targetSeatNo}号位 -> ${result}`);
  }

  /**
   * 写入狼人刀人事件
   */
  async writeWolfKillEvent(options: {
    gameId: string;
    day: number;
    targetId?: string | null;
    targetSeatNo?: number;
  }): Promise<void> {
    const { gameId, day, targetId, targetSeatNo } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'night',
        actionType: ACTION_TYPES.WOLF_KILL,
        visibility: VISIBILITY_TYPES.WOLF, // 只有狼人可见（刀人决策）
        actorId: null, // 狼队集体决策，没有单一 actor
        targetIds: targetId ? [targetId] : [], // 空刀时为空数组
        content: {
          targetSeatNo,
          cause: 'night_kill',
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(
      `[Event] 写入狼人刀人: Day ${day}, ${targetSeatNo ? `${targetSeatNo}号位` : '空刀'}`,
    );
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
  }): Promise<void> {
    const { gameId, day, actorId, targetId, targetSeatNo, thinking } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'night',
        actionType: ACTION_TYPES.WITCH_SAVE,
        visibility: VISIBILITY_TYPES.WITCH,
        actorId,
        targetIds: [targetId],
        content: {
          targetSeatNo,
          saved: targetSeatNo !== 0,
          thinking,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(
      `[Event] 写入女巫解药: Day ${day}, ${targetSeatNo === 0 ? '未使用' : `救了 ${targetSeatNo}号位`}`,
    );
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
  }): Promise<void> {
    const { gameId, day, actorId, targetId, targetSeatNo, thinking } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'night',
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
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(
      `[Event] 写入女巫毒药: Day ${day}, ${targetSeatNo === 0 ? '未使用' : `毒了 ${targetSeatNo}号位`}`,
    );
  }

  /**
   * 写入死亡公告事件
   */
  async writeDeathAnnouncementEvent(options: {
    gameId: string;
    day: number;
    deaths: Array<{ playerId: string; seatNo: number; cause: string }>;
  }): Promise<void> {
    const { gameId, day, deaths } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'day_announce',
        actionType: 'death_announcement',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: deaths.map((d) => d.playerId),
        content: {
          deaths: deaths.map((d) => ({
            seatNo: d.seatNo,
            cause: d.cause,
          })),
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入死亡公告: Day ${day}, ${deaths.length} 人死亡`);
  }

  /**
   * 写入平安夜事件
   */
  async writePeacefulNightEvent(options: { gameId: string; day: number }): Promise<void> {
    const { gameId, day } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'day_announce',
        actionType: 'peaceful_night',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: {
          message: '昨晚是平安夜',
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入平安夜: Day ${day}`);
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
  }): Promise<number> {
    const { gameId, day, actorId, seatNo, content, thinking } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'speech',
        actionType: 'player_speech',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId,
        targetIds: [],
        content: {
          seatNo,
          speech: content,
          thinking,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入玩家发言: Day ${day}, ${seatNo}号位`);

    return sequence;
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
  }): Promise<number> {
    const { gameId, day, actorId, seatNo, content, round, thinking } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'night',
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
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入狼人讨论: Day ${day}, 第${round}轮, ${seatNo}号位`);

    return sequence;
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
  }): Promise<void> {
    const { gameId, day, actorId, voterSeatNo, targetSeatNo } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'vote',
        actionType: 'player_vote',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId,
        targetIds: [],
        content: {
          voterSeatNo,
          targetSeatNo,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(
      `[Event] 写入玩家投票: Day ${day}, ${voterSeatNo}号位 -> ${targetSeatNo}号位`,
    );
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
  }): Promise<void> {
    const { gameId, day, targetId, targetSeatNo, voteCount } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'execute',
        actionType: 'player_exiled',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [targetId],
        content: {
          targetSeatNo,
          voteCount,
          message: `${targetSeatNo}号位被放逐出局`,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入放逐执行: Day ${day}, ${targetSeatNo}号位`);
  }

  /**
   * 写入白痴翻牌事件
   */
  async writeIdiotRevealEvent(options: {
    gameId: string;
    day: number;
    playerId: string;
    seatNo: number;
  }): Promise<void> {
    const { gameId, day, playerId, seatNo } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'execute',
        actionType: 'idiot_reveal',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: playerId,
        targetIds: [],
        content: {
          seatNo,
          message: `${seatNo}号位白痴翻牌，免疫死亡`,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入白痴翻牌: Day ${day}, ${seatNo}号位`);
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
  }): Promise<void> {
    const { gameId, day, sheriffId, sheriffSeatNo, direction } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'speech',
        actionType: 'sheriff_decide_order',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: sheriffId,
        targetIds: [],
        content: {
          sheriffSeatNo,
          direction,
          message: `警长${sheriffSeatNo}号位决定从${direction === 'left' ? '左手' : '右手'}开始发言（${direction === 'left' ? '逆时针' : '顺时针'}）`,
        },
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(
      `[Event] 写入警长决定发言顺序: Day ${day}, ${direction === 'left' ? '左手（逆时针）' : '右手（顺时针）'}`,
    );
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
  }): Promise<void> {
    const { gameId, day, speechOrder, startSeatNo, direction, reason } = options;

    const sequence = await this.getNextSequence(gameId);

    const event = await this.prisma.event.create({
      data: {
        gameId,
        sequence,
        day,
        phase: 'speech',
        actionType: 'speech_order_determined',
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
      },
    });

    await this.eventBus.publish(event);

    this.logger.debug(`[Event] 写入发言顺序: Day ${day}, ${speechOrder.join(' → ')} (${reason})`);
  }

  /** 游戏开始系统事件 */
  async writeGameStartEvent(params: { gameId: string; playerCount: number }): Promise<void> {
    const sequence = await this.getNextSequence(params.gameId);
    const event = await this.prisma.event.create({
      data: {
        gameId: params.gameId,
        sequence,
        day: 0,
        phase: 'system',
        actionType: 'GAME_START',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { playerCount: params.playerCount },
      },
    });
    await this.eventBus.publish(event);
  }

  /** 游戏结束系统事件 */
  async writeGameEndEvent(params: { gameId: string; winner: string }): Promise<void> {
    const sequence = await this.getNextSequence(params.gameId);
    const event = await this.prisma.event.create({
      data: {
        gameId: params.gameId,
        sequence,
        day: 0,
        phase: 'system',
        actionType: 'GAME_END',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { winner: params.winner },
      },
    });
    await this.eventBus.publish(event);
  }

  /** 法官播报事件（公开） */
  async writeJudgeEvent(params: {
    gameId: string;
    day: number;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const sequence = await this.getNextSequence(params.gameId);
    const event = await this.prisma.event.create({
      data: {
        gameId: params.gameId,
        sequence,
        day: params.day,
        phase: 'judge',
        actionType: 'JUDGE_ANNOUNCE',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { content: params.content, ...params.metadata } as Prisma.InputJsonValue,
      },
    });
    await this.eventBus.publish(event);
  }

  /** 夜间法官引导事件 */
  async writeNightPromptEvent(params: {
    gameId: string;
    day: number;
    content: string;
    targetRole: string;
  }): Promise<void> {
    const sequence = await this.getNextSequence(params.gameId);
    const event = await this.prisma.event.create({
      data: {
        gameId: params.gameId,
        sequence,
        day: params.day,
        phase: 'night',
        actionType: 'NIGHT_PROMPT',
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { content: params.content, targetRole: params.targetRole },
      },
    });
    await this.eventBus.publish(event);
  }

  /**
   * 获取下一个 sequence
   */
  private async getNextSequence(gameId: string): Promise<number> {
    const lastEvent = await this.prisma.event.findFirst({
      where: { gameId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    return (lastEvent?.sequence || 0) + 1;
  }
}

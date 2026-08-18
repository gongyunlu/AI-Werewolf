import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Event } from '../generated/prisma/client';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import type { SceneType, SceneVisibility } from '../sse/sse-event.types';

const ACTION_TO_SCENE_TYPE: Record<string, SceneType> = {
  // 夜间行动
  wolf_kill: 'night_action',
  seer_check: 'night_action',
  witch_save: 'night_action',
  witch_poison: 'night_action',
  // 白天行动
  speech: 'speech', // 包含狼队商议（wolf visibility）
  vote: 'vote',
  // 公告类
  death_announcement: 'judge',
  peaceful_night: 'judge',
  player_executed: 'judge',
  player_died: 'judge',
  idiot_flip: 'judge',
  sheriff_decide_order: 'judge',
  speech_order_determined: 'judge',
  // 系统/法官事件
  GAME_START: 'system',
  GAME_END: 'system',
  JUDGE_ANNOUNCE: 'judge',
  NIGHT_PROMPT: 'night_prompt',
};

/** 将 event.content 转为人类可读文本（用于 scene.close 的 fullContent） */
function formatContent(event: Event): string {
  const content = event.content as Record<string, unknown>;

  // 优先使用 message / content / speech 字段作为展示文本
  const display = content.message ?? content.content ?? content.speech;
  if (typeof display === 'string') return display;

  // 针对特定 actionType 生成人类可读文本
  switch (event.actionType) {
    case 'seer_check': {
      const targetSeatNo = content.targetSeatNo;
      const result = content.result === 'werewolf' ? '狼人' : '好人';
      return `查验了 ${targetSeatNo}号位，结果：${result}`;
    }
    case 'witch_save': {
      const targetSeatNo = content.targetSeatNo;
      const saved = content.saved;
      if (saved && targetSeatNo && targetSeatNo !== 0) {
        return `女巫使用解药救了 ${targetSeatNo}号位`;
      }
      return '女巫未使用解药';
    }
    case 'witch_poison': {
      const targetSeatNo = content.targetSeatNo;
      const used = content.used;
      if (used && targetSeatNo && targetSeatNo !== 0) {
        return `女巫使用毒药毒了 ${targetSeatNo}号位`;
      }
      return '女巫未使用毒药';
    }
    case 'wolf_kill': {
      const targetSeatNo = content.targetSeatNo;
      if (targetSeatNo) {
        return `狼人刀了 ${targetSeatNo}号位`;
      }
      return '狼人空刀';
    }
    case 'death_announcement': {
      const deaths = content.deaths as Array<{ seatNo: number; cause: string }>;
      if (deaths && deaths.length > 0) {
        return deaths.map((d) => `${d.seatNo}号位（${d.cause}）`).join('、') + ' 出局';
      }
      return '昨晚无人出局';
    }
    default:
      // 兜底：取 content 对象中所有 string 值拼接
      return Object.values(content)
        .filter((v) => typeof v === 'string' && v)
        .join('\n');
  }
}

/**
 * EventBus: 游戏事件的统一广播层
 *
 * 职责：接收已持久化的事件
 * 不负责持久化，只做消息分发
 */
@Injectable()
export class EventBusService {
  private readonly logger = new Logger(EventBusService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly sseBroadcaster: SseBroadcasterService,
  ) {}

  /**
   * 发布事件
   *
   * @param event 已持久化的事件记录
   */
  async publish(event: Event): Promise<void> {
    this.logger.debug(
      `Event published: ${event.actionType} (seq=${event.sequence}, game=${event.gameId})`,
    );

    if (!this.sseBroadcaster) return;

    const sceneType = ACTION_TO_SCENE_TYPE[event.actionType];
    if (!sceneType) return;

    const visibility: SceneVisibility = (event.visibility as SceneVisibility) ?? 'public';
    const sceneId = event.id;

    this.sseBroadcaster.emit(event.gameId, {
      type: 'scene.open',
      sceneId,
      sceneType: sceneType as SceneType,
      visibility,
      actorId: event.actorId ?? undefined,
    });

    this.sseBroadcaster.emit(event.gameId, {
      type: 'scene.close',
      sceneId,
      fullContent: formatContent(event),
      durationMs: 0,
    });
  }
}

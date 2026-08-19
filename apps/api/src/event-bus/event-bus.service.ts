import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Event } from '../generated/prisma/client';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { ACTION_TYPES, SEER_CHECK_RESULTS, VISIBILITY_TYPES } from '@ai-werewolf/shared';
import type { SceneType, SceneVisibility } from '../sse/sse-event.types';

const ACTION_TO_SCENE_TYPE: Record<string, SceneType> = {
  // 夜间行动
  [ACTION_TYPES.WOLF_KILL]: 'night_action',
  [ACTION_TYPES.SEER_CHECK]: 'night_action',
  [ACTION_TYPES.WITCH_SAVE]: 'night_action',
  [ACTION_TYPES.WITCH_POISON]: 'night_action',
  // 白天行动
  // speech 类事件由节点直接流式 emit，不在此广播，避免落库后再广播出现两张卡片
  [ACTION_TYPES.VOTE]: 'vote',
  // 公告类
  [ACTION_TYPES.PEACEFUL_NIGHT]: 'judge',
  [ACTION_TYPES.PLAYER_EXECUTED]: 'judge',
  [ACTION_TYPES.PLAYER_DIED]: 'judge',
  [ACTION_TYPES.IDIOT_FLIP]: 'judge',
  [ACTION_TYPES.SHERIFF_DECIDE_ORDER]: 'judge',
  [ACTION_TYPES.SPEECH_ORDER_DETERMINED]: 'judge',
  // 系统/法官事件
  [ACTION_TYPES.GAME_STARTED]: 'system',
  [ACTION_TYPES.GAME_ENDED]: 'system',
  [ACTION_TYPES.JUDGE_ANNOUNCE]: 'judge',
  [ACTION_TYPES.NIGHT_PROMPT]: 'night_prompt',
};

/** 将 event.content 转为人类可读文本（用于 scene.open 的 initialContent） */
function formatContent(event: Event): string {
  const content = event.content as Record<string, unknown>;

  // 优先使用 message / content / speech 字段作为展示文本
  const display = content.message ?? content.content ?? content.speech;
  if (typeof display === 'string') return display;

  // 针对特定 actionType 生成人类可读文本
  switch (event.actionType) {
    case ACTION_TYPES.SEER_CHECK: {
      const targetSeatNo = content.targetSeatNo;
      const result = content.result === SEER_CHECK_RESULTS.WEREWOLF ? '狼人' : '好人';
      return `查验了 ${targetSeatNo}号位，结果：${result}`;
    }
    case ACTION_TYPES.WITCH_SAVE: {
      const targetSeatNo = content.targetSeatNo;
      const saved = content.saved;
      if (saved && targetSeatNo && targetSeatNo !== 0) {
        return `女巫使用解药救了 ${targetSeatNo}号位`;
      }
      return '女巫未使用解药';
    }
    case ACTION_TYPES.WITCH_POISON: {
      const targetSeatNo = content.targetSeatNo;
      const used = content.used;
      if (used && targetSeatNo && targetSeatNo !== 0) {
        return `女巫使用毒药毒了 ${targetSeatNo}号位`;
      }
      return '女巫未使用毒药';
    }
    case ACTION_TYPES.WOLF_KILL: {
      const targetSeatNo = content.targetSeatNo;
      if (targetSeatNo) {
        return `狼人刀了 ${targetSeatNo}号位`;
      }
      return '狼人空刀';
    }
    case ACTION_TYPES.VOTE: {
      const voterSeatNo = content.voterSeatNo;
      const targetSeatNo = content.targetSeatNo;
      if (targetSeatNo && targetSeatNo !== 0) {
        return `${voterSeatNo}号位投票给 ${targetSeatNo}号位`;
      }
      return `${voterSeatNo}号位弃票`;
    }
    case ACTION_TYPES.PLAYER_DIED: {
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

/** 提取事件的结构化元数据（用于前端渲染特殊效果） */
function extractMetadata(event: Event): Record<string, unknown> | undefined {
  const content = event.content as Record<string, unknown>;

  switch (event.actionType) {
    case ACTION_TYPES.VOTE:
      return {
        action: 'vote',
        voterSeatNo: content.voterSeatNo,
        targetSeatNo: content.targetSeatNo,
      };
    case ACTION_TYPES.WOLF_KILL:
      return {
        action: 'wolf_kill',
        targetSeatNo: content.targetSeatNo,
      };
    case ACTION_TYPES.WITCH_SAVE:
      return {
        action: 'witch_save',
        targetSeatNo: content.targetSeatNo,
        saved: content.saved,
      };
    case ACTION_TYPES.WITCH_POISON:
      return {
        action: 'witch_poison',
        targetSeatNo: content.targetSeatNo,
        used: content.used,
      };
    default:
      return undefined;
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
    if (!this.sseBroadcaster) return;

    const sceneType = ACTION_TO_SCENE_TYPE[event.actionType];
    if (!sceneType) return;

    const visibility: SceneVisibility =
      (event.visibility as SceneVisibility) ?? VISIBILITY_TYPES.PUBLIC;
    const sceneId = event.id;
    const metadata = extractMetadata(event);

    this.sseBroadcaster.emit(event.gameId, {
      type: 'scene.open',
      sceneId,
      sceneType: sceneType as SceneType,
      visibility,
      actorId: event.actorId ?? undefined,
      initialContent: formatContent(event),
      metadata,
    });

    this.sseBroadcaster.emit(event.gameId, {
      type: 'scene.close',
      sceneId,
      thinkingDurationMs: 0,
      contentDurationMs: 0,
    });
  }
}

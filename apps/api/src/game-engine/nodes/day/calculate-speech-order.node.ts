import type { GameGraphState } from '@/game-engine/core/types';
import type { NodeFactory } from '@/game-engine/nodes/node.types';
import {
  calculateSpeechOrder,
  type SpeechOrderConfig,
} from '@/game-engine/utils/speech-order.utils';
import type { TypedRuleset } from '@/prisma/typed-models';

/**
 * 计算发言顺序节点（无警长）
 *
 * 规则：
 * - 优先从死者位置开始
 * - 无死者时使用时间规则
 * - 降级为从 1 号位开始顺时针
 */
export const createCalculateSpeechOrderNode: NodeFactory = (context) => {
  return async (state: GameGraphState) => {
    // 如果已经有发言顺序（警长已指定），跳过
    if (state.speechOrder && state.speechOrder.length > 0) {
      return {};
    }

    // 从 ruleset 读取配置
    const ruleset = (await context.prisma.ruleset.findUnique({
      where: { id: state.rulesetId },
    })) as TypedRuleset | null;

    if (!ruleset) {
      throw new Error(`[计算发言顺序] 数据一致性错误：未找到 ruleset ${state.rulesetId}`);
    }

    const config: SpeechOrderConfig = ruleset.definition.speechRules || {
      useTimeRule: true,
      timeRuleConfig: {
        oddMinuteDirection: 'clockwise',
        evenMinuteDirection: 'counterclockwise',
      },
      useDeathPosition: true,
      deathPositionOffset: 'next',
    };

    // 计算发言顺序
    const orderResult = calculateSpeechOrder({
      state,
      config,
      currentTime: new Date(),
    });

    // 写入 Event（记录发言顺序）
    await context.eventWriter.writeSpeechOrderDeterminedEvent({
      gameId: state.gameId,
      day: state.currentDay,
      speechOrder: orderResult.speechOrder,
      startSeatNo: orderResult.startSeatNo,
      direction: orderResult.direction,
      reason: orderResult.reason,
    });

    // 写入状态
    return {
      speechOrder: orderResult.speechOrder,
      speechDirection: orderResult.direction,
      speechStartSeatNo: orderResult.startSeatNo,
      speechOrderReason: orderResult.reason,
    };
  };
};

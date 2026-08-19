import type { NodeFactory } from '../node.types';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import { nodeRegistry } from '../node-registry';

/**
 * 白天阶段节点工厂
 *
 * 管道化执行所有白天节点（根据板子配置）
 */
export const createDayPipelineNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<GameGraphUpdate> => {
    const { preset } = context;

    if (!preset) {
      throw new Error('preset 未在 NodeContext 中设置');
    }

    let currentState = state;
    for (const nodeName of preset.dayPipeline) {
      const node = nodeRegistry.getNode(nodeName, context);
      const updates = await node(currentState);
      currentState = Object.assign({}, currentState, updates);

      // 如果游戏已结束，立即中断白天管道
      if (currentState.isGameOver) {
        break;
      }
    }

    // 白天结束，天数 +1，标记下一阶段是夜晚
    return Object.assign({}, currentState, {
      currentDay: currentState.currentDay + 1,
      nextIsDay: false,
    });
  };
};

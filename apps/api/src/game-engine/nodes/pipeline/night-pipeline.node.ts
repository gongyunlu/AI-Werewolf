import type { NodeFactory } from '../node.types';
import type { GameGraphState, GameGraphUpdate } from '../../core/types';
import { nodeRegistry } from '../node-registry';

/**
 * 夜晚阶段节点工厂
 *
 * 管道化执行所有夜间节点（根据板子配置）
 */
export const createNightPipelineNode: NodeFactory = (context) => {
  return async (state: GameGraphState): Promise<GameGraphUpdate> => {
    const { preset } = context;

    if (!preset) {
      throw new Error('preset 未在 NodeContext 中设置');
    }

    // 执行夜间管道
    let currentState = state;
    for (const nodeName of preset.nightPipeline) {
      const node = nodeRegistry.getNode(nodeName, context);
      const updates = await node(currentState);
      currentState = Object.assign({}, currentState, updates);
    }

    // 夜晚结束，标记下一阶段是白天
    return Object.assign({}, currentState, { nextIsDay: true });
  };
};

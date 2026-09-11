import type { GameNode, NodeFactory, NodeContext } from './node.types';
import { createNightResolveNode } from './night/night-resolve.node';
import { createAnnounceDayNode } from './day/announce-day.node';
import { checkWinNode } from './shared/check-win.node';
import { createExecuteNode } from './day/execute.node';
import { createInitNode } from './init/init.node';
import { createGameEndNode } from './shared/game-end.node';
import { processDeathSkillsNode } from './day/process-death-skills.node';
import { createProcessExileSkillsNode } from './day/process-exile-skills.node';
import { createCalculateSpeechOrderNode } from './day/calculate-speech-order.node';

/**
 * 节点注册表
 *
 * 在装配时固定节点工厂，运行中的对局只读取各自装配实例的注册表。
 */
export class NodeRegistry {
  private readonly factories: ReadonlyMap<string, NodeFactory>;
  private readonly staticNodes: ReadonlyMap<string, GameNode> = new Map([
    ['checkWin', checkWinNode],
    ['processDeathSkills', processDeathSkillsNode],
  ]);

  constructor(factories: Readonly<Record<string, NodeFactory>>) {
    this.factories = new Map(
      Object.entries({
        nightResolve: createNightResolveNode,
        announceDay: createAnnounceDayNode,
        processExileSkills: createProcessExileSkillsNode,
        execute: createExecuteNode,
        calculateSpeechOrder: createCalculateSpeechOrderNode,
        init: createInitNode,
        gameEnd: createGameEndNode,
        ...factories,
      }),
    );
  }

  /**
   * 获取节点（根据上下文构建）
   */
  getNode(name: string, context: NodeContext): GameNode {
    // 暂停检查包装器按局存放在 context 中，避免并发对局互相覆盖（见 GameEngine.initialize）
    const wrap = context.pauseCheckWrapper;

    // 优先查找静态节点
    const staticNode = this.staticNodes.get(name);
    if (staticNode) {
      return wrap ? wrap(staticNode) : staticNode;
    }

    // 查找工厂并构建节点
    const factory = this.factories.get(name);
    if (factory) {
      const node = factory(context);
      return wrap ? wrap(node) : node;
    }

    throw new Error(`Node '${name}' not found in registry`);
  }

  /**
   * 获取所有已注册的节点名称
   */
  getRegisteredNodes(): string[] {
    return [...Array.from(this.factories.keys()), ...Array.from(this.staticNodes.keys())];
  }
}

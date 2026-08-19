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
import { createNightPipelineNode } from './pipeline/night-pipeline.node';
import { createDayPipelineNode } from './pipeline/day-pipeline.node';

/**
 * 节点注册表
 *
 * 所有游戏节点的中央注册表，用于配置驱动的主图构建
 */
export class NodeRegistry {
  private factories: Map<string, NodeFactory> = new Map();
  private staticNodes: Map<string, GameNode> = new Map();

  constructor() {
    this.registerDefaultNodes();
  }

  /**
   * 注册默认节点
   */
  private registerDefaultNodes() {
    // 需要依赖注入的节点（工厂模式）
    this.factories.set('nightPipeline', createNightPipelineNode);
    this.factories.set('dayPipeline', createDayPipelineNode);
    this.factories.set('nightResolve', createNightResolveNode);
    this.factories.set('announceDay', createAnnounceDayNode);
    this.factories.set('processExileSkills', createProcessExileSkillsNode);
    this.factories.set('execute', createExecuteNode);
    this.factories.set('calculateSpeechOrder', createCalculateSpeechOrderNode);
    this.factories.set('init', createInitNode);
    this.factories.set('gameEnd', createGameEndNode);

    // 无需依赖注入的节点（静态节点）
    this.staticNodes.set('checkWin', checkWinNode);
    this.staticNodes.set('processDeathSkills', processDeathSkillsNode);
  }

  /**
   * 注册节点工厂
   */
  registerFactory(name: string, factory: NodeFactory) {
    this.factories.set(name, factory);
  }

  /**
   * 注册静态节点
   */
  registerStaticNode(name: string, node: GameNode) {
    this.staticNodes.set(name, node);
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

/**
 * 全局节点注册表实例
 */
export const nodeRegistry = new NodeRegistry();

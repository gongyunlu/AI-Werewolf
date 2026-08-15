import type { GameNode, NodeFactory, NodeContext } from './node.types';
import { createWerewolfKillNode } from './night/werewolf-kill.node';
import { createWitchAntidoteNode } from './night/witch-antidote.node';
import { createWitchPoisonNode } from './night/witch-poison.node';
import { createSeerCheckNode } from './night/seer-check.node';
import { createNightResolveNode } from './night/night-resolve.node';
import { createAnnounceDayNode } from './day/announce-day.node';
import { createLastWordsNode } from './day/last-words.node';
import { createExileLastWordsNode } from './day/exile-last-words.node';
import { checkWinNode } from './shared/check-win.node';
import { createSpeechNode } from './day/speech.node';
import { createVoteNode } from './day/vote.node';
import { createExecuteNode } from './day/execute.node';
import { createInitNode } from './init/init.node';
import { createGameEndNode } from './shared/game-end.node';
import { processDeathSkillsNode } from './day/process-death-skills.node';
import { createProcessExileSkillsNode } from './day/process-exile-skills.node';
import { createSheriffDecideOrderNode } from './day/sheriff-decide-order.node';
import { createCalculateSpeechOrderNode } from './day/calculate-speech-order.node';
import { createPkSpeechNode } from './day/pk-speech.node';
import { createPkVoteNode } from './day/pk-vote.node';
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
  private pauseCheckWrapper?: (node: GameNode) => GameNode;

  constructor() {
    this.registerDefaultNodes();
  }

  /**
   * 设置暂停检查包装器（由 GameEngine 注入）
   */
  setPauseCheckWrapper(wrapper: (node: GameNode) => GameNode) {
    this.pauseCheckWrapper = wrapper;
  }

  /**
   * 清除暂停检查包装器
   */
  clearPauseCheckWrapper() {
    this.pauseCheckWrapper = undefined;
  }

  /**
   * 注册默认节点
   */
  private registerDefaultNodes() {
    // 需要依赖注入的节点（工厂模式）
    this.factories.set('nightPipeline', createNightPipelineNode);
    this.factories.set('dayPipeline', createDayPipelineNode);
    this.factories.set('werewolfKill', createWerewolfKillNode);
    this.factories.set('witchAntidote', createWitchAntidoteNode);
    this.factories.set('witchPoison', createWitchPoisonNode);
    this.factories.set('seerCheck', createSeerCheckNode);
    this.factories.set('nightResolve', createNightResolveNode);
    this.factories.set('announceDay', createAnnounceDayNode);
    this.factories.set('lastWords', createLastWordsNode);
    this.factories.set('exileLastWords', createExileLastWordsNode);
    this.factories.set('processExileSkills', createProcessExileSkillsNode);
    this.factories.set('speech', createSpeechNode);
    this.factories.set('vote', createVoteNode);
    this.factories.set('execute', createExecuteNode);
    this.factories.set('sheriffDecideOrder', createSheriffDecideOrderNode);
    this.factories.set('calculateSpeechOrder', createCalculateSpeechOrderNode);
    this.factories.set('pkSpeech', createPkSpeechNode);
    this.factories.set('pkVote', createPkVoteNode);
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
    // 优先查找静态节点
    const staticNode = this.staticNodes.get(name);
    if (staticNode) {
      return this.pauseCheckWrapper ? this.pauseCheckWrapper(staticNode) : staticNode;
    }

    // 查找工厂并构建节点
    const factory = this.factories.get(name);
    if (factory) {
      const node = factory(context);
      return this.pauseCheckWrapper ? this.pauseCheckWrapper(node) : node;
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

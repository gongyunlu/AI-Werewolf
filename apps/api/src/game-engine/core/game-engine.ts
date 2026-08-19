import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type GameGraphState, type GameGraphUpdate } from './types';
import { nodeRegistry } from '../nodes/node-registry';
import type { NodeContext } from '../nodes/node.types';
import type { GamePreset } from '../presets/game-presets';
import { DEFAULT_PRESET } from '../presets/game-presets';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import { PrismaService } from '@/prisma/prisma.service';
import { EventWriterService } from '../events/event-writer.service';
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import { EventBusService } from '@/event-bus/event-bus.service';
import { GamePausedException, GameAbortedException } from './game-engine.exception';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { gameLogger } from '../utils/game-logger';
import { NodeRegistrar } from '../nodes/node-registrar.service';
import { SpeechSummarizerService } from '@/speech-summarizer/speech-summarizer.service';
import type { Env } from '@/config/env.validation';

/**
 * 游戏引擎 - 简单状态机实现
 *
 * 职责：
 * - 管理游戏流程（INIT → NIGHT → DAY → 循环）
 * - 执行游戏规则（谁先行动、何时结束）
 * - 调用节点处理具体逻辑
 */
@Injectable()
export class GameEngine {
  private nodeContext: NodeContext;
  private preset?: GamePreset;
  private initialized = false;
  private pauseCheckCache: { status: string; timestamp: number } | null = null;
  private readonly PAUSE_CHECK_CACHE_TTL = 1000; // 1秒缓存

  constructor(
    private readonly agentRuntime: AgentRuntimeService,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly prisma: PrismaService,
    private readonly eventWriter: EventWriterService,
    private readonly broadcaster: SseBroadcasterService,
    private readonly nodeRegistrar: NodeRegistrar,
    private readonly eventBus: EventBusService,
    private readonly configService: ConfigService<Env, true>,
    private readonly speechSummarizer: SpeechSummarizerService,
  ) {
    this.nodeContext = {
      agentRuntime,
      toolsFactory,
      prisma,
      eventWriter,
      broadcaster,
      eventBus,
      configService,
    };
  }

  /**
   * 运行游戏主循环
   */
  async run(
    initialState: GameGraphState,
    preset?: GamePreset,
    signal?: AbortSignal,
  ): Promise<GameGraphState> {
    // 初始化
    this.initialize(preset, signal);

    gameLogger.log(`[游戏开始] gameId: ${initialState.gameId}`);

    let state = initialState;

    try {
      // 主循环
      while (!state.isGameOver) {
        // 检查暂停/取消
        await this.checkPause(state);

        // 执行当前阶段
        state = await this.executePhase(state);

        // 胜负判定
        state = await this.executeNode('checkWin', state);
      }

      // 游戏结束
      state = await this.executeNode('gameEnd', state);
      gameLogger.log(`[游戏结束] 胜方: ${state.winner ?? '未产生'}`);

      return state;
    } catch (error) {
      if (error instanceof GamePausedException || error instanceof GameAbortedException) {
        throw error;
      }
      throw error;
    } finally {
      this.pauseCheckCache = null;
    }
  }

  /**
   * 初始化游戏引擎
   */
  private initialize(preset?: GamePreset, signal?: AbortSignal) {
    if (this.initialized) return;

    this.preset = preset ?? DEFAULT_PRESET;

    // 注册节点（必须在验证配置之前）
    this.nodeRegistrar.registerAll();

    // 验证配置合法性
    this.validatePreset(this.preset);

    // 注入配置和信号到上下文
    this.nodeContext.preset = this.preset;
    if (signal) {
      this.nodeContext.signal = signal;
    }

    // 注入暂停检查包装器到本局上下文（而非模块级单例，避免并发对局互相覆盖）
    this.nodeContext.pauseCheckWrapper = (node) => {
      return async (state: GameGraphState): Promise<GameGraphUpdate> => {
        await this.checkPause(state);
        return node(state);
      };
    };

    this.initialized = true;
  }

  /**
   * 验证板子配置合法性
   */
  private validatePreset(preset: GamePreset): void {
    const { nightPipeline, dayPipeline } = preset;

    // nightResolve 必须在夜间管道最后
    const lastNightNode = nightPipeline[nightPipeline.length - 1];
    if (lastNightNode !== 'nightResolve') {
      throw new Error(
        `配置错误：nightPipeline 最后必须是 'nightResolve'，当前是 '${lastNightNode}'`,
      );
    }

    // 所有节点必须已注册
    const allNodes = [...nightPipeline, ...dayPipeline];
    const registeredNodes = nodeRegistry.getRegisteredNodes();

    for (const nodeName of allNodes) {
      if (!registeredNodes.includes(nodeName)) {
        throw new Error(`配置错误：节点 '${nodeName}' 未在 nodeRegistry 中注册。`);
      }
    }
  }

  /**
   * 检查游戏是否被暂停或取消
   */
  private async checkPause(state: GameGraphState): Promise<void> {
    const now = Date.now();

    if (this.pauseCheckCache && now - this.pauseCheckCache.timestamp < this.PAUSE_CHECK_CACHE_TTL) {
      if (this.pauseCheckCache.status === GAME_STATUSES.ABORTED) {
        throw new GameAbortedException(state.gameId);
      }
      if (this.pauseCheckCache.status === GAME_STATUSES.PAUSED) {
        throw new GamePausedException(state.gameId);
      }
      return;
    }

    const game = await this.prisma.game.findUnique({
      where: { id: state.gameId },
      select: { status: true },
    });

    if (game) {
      this.pauseCheckCache = { status: game.status, timestamp: now };
    }

    if (game?.status === GAME_STATUSES.ABORTED) {
      throw new GameAbortedException(state.gameId);
    }
    if (game?.status === GAME_STATUSES.PAUSED) {
      throw new GamePausedException(state.gameId);
    }
  }

  /**
   * 执行当前阶段
   */
  private async executePhase(state: GameGraphState): Promise<GameGraphState> {
    // 根据 nextIsDay 标记决定执行哪个阶段
    if (state.nextIsDay) {
      return await this.executeDayPhase(state);
    } else {
      return await this.executeNightPhase(state);
    }
  }

  /**
   * 夜间阶段
   */
  private async executeNightPhase(state: GameGraphState): Promise<GameGraphState> {
    // 每夜开始前重置夜间临时目标，避免跨夜状态泄漏
    // （nightDeaths 保留，供 announce-day 消费）
    let currentState: GameGraphState = {
      ...state,
      wolfTarget: null,
      witchAntidoteTarget: null,
      witchPoisonTarget: null,
      guardTarget: null,
      seerCheckTarget: null,
    };

    // 执行夜间管道
    for (const nodeName of this.preset!.nightPipeline) {
      currentState = await this.executeNode(nodeName, currentState);
    }

    // 夜晚结束，标记下一阶段是白天
    return { ...currentState, nextIsDay: true };
  }

  /**
   * 白天阶段
   */
  private async executeDayPhase(state: GameGraphState): Promise<GameGraphState> {
    // 执行白天管道
    let currentState = state;
    for (const nodeName of this.preset!.dayPipeline) {
      currentState = await this.executeNode(nodeName, currentState);

      // 检查中断：如果白天阶段触发了中断（如狼人自爆），跳到夜晚
      if (
        currentState.interrupt?.type === 'wolf_explode' ||
        currentState.interrupt?.type === 'white_wolf_explode'
      ) {
        return { ...currentState, nextIsDay: false };
      }

      // 如果游戏已结束，立即中断白天管道
      if (currentState.isGameOver) {
        break;
      }
    }

    // 白天正常结束（非狼人自爆中断、非游戏结束），统一生成摘要与判断
    if (!currentState.isGameOver) {
      await this.generateDaySummaries(currentState.gameId, currentState.currentDay);
    }

    // 白天结束，天数 +1，标记下一阶段是夜晚
    return {
      ...currentState,
      currentDay: currentState.currentDay + 1,
      nextIsDay: false,
    };
  }

  /**
   * 白天结束时统一生成摘要与判断（底层上下文维护，非游戏节点）
   *
   * 失败仅记录日志，不阻塞游戏进程。
   */
  private async generateDaySummaries(gameId: string, day: number): Promise<void> {
    try {
      await this.speechSummarizer.generateDaySummaries(gameId, day);
    } catch (error) {
      gameLogger.error(
        `[日间总结] 生成失败: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * 执行单个节点
   */
  private async executeNode(nodeName: string, state: GameGraphState): Promise<GameGraphState> {
    const node = nodeRegistry.getNode(nodeName, this.nodeContext);
    const updates = await node(state);
    return { ...state, ...updates };
  }
}

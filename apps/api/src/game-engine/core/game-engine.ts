import { Logger, Injectable } from '@nestjs/common';
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { GameStateAnnotation, GAME_NODE, type GameGraphState, type GameGraphUpdate } from './types';
import { nodeRegistry } from '../nodes/node-registry';
import type { NodeContext, GameNode } from '../nodes/node.types';
import type { GamePreset } from '../presets/game-presets';
import { DEFAULT_PRESET } from '../presets/game-presets';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import { PrismaService } from '@/prisma/prisma.service';
import { EventWriterService } from '../events/event-writer.service';
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import { GamePausedException, GameAbortedException } from './game-engine.exception';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { gameLogger } from '../utils/game-logger';

/**
 * 狼人杀游戏引擎（配置驱动的管道架构）
 *
 * 设计理念：
 * - 游戏 = 状态在节点间流转
 * - 节点 = 纯函数：(State) => State
 * - 管道 = 节点串联执行
 * - 配置 = 定义管道顺序
 * - 主图拓扑固定，板子差异体现在 Pipeline 配置中
 */
@Injectable()
export class GameEngine {
  private readonly logger = new Logger(GameEngine.name);
  private graph?: ReturnType<typeof GameEngine.prototype.buildGraph>;
  private checkpointer?: MemorySaver | PostgresSaver;
  private nodeContext: NodeContext;
  private preset?: GamePreset;
  private initialized = false;
  private pauseCheckCache: { status: string; timestamp: number } | null = null;
  private readonly PAUSE_CHECK_CACHE_TTL = 1000; // 1秒缓存

  /**
   * @param agentRuntime Agent 运行时服务
   * @param toolsFactory 工具工具
   * @param prisma 数据库服务
   * @param eventWriter Event 写入服务
   * @param broadcaster SSE 广播服务
   */
  constructor(
    private readonly agentRuntime: AgentRuntimeService,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly prisma: PrismaService,
    private readonly eventWriter: EventWriterService,
    private readonly broadcaster: SseBroadcasterService,
  ) {
    // 仅构建节点上下文，延迟其他初始化
    this.nodeContext = {
      agentRuntime,
      toolsFactory,
      prisma,
      eventWriter,
      broadcaster,
    };
  }

  /**
   * 初始化游戏引擎（延迟初始化，仅在首次 run 时调用）
   */
  private initialize(checkpointer?: MemorySaver | PostgresSaver, preset?: GamePreset) {
    if (this.initialized) return;

    // 设置板子配置
    this.preset = preset ?? DEFAULT_PRESET;
    gameLogger.log(`使用板子配置: ${this.preset.name}`);

    // 验证配置合法性
    this.validatePreset(this.preset);

    // 将 preset 注入到 nodeContext，供 NIGHT/DAY 节点使用
    this.nodeContext.preset = this.preset;

    // 注入暂停检查包装器到 nodeRegistry
    // 这样所有从 nodeRegistry 获取的节点都会自动被包装
    nodeRegistry.setPauseCheckWrapper((node: GameNode) => {
      return this.wrapNodeWithPauseCheck(node);
    });

    // 构建图
    this.checkpointer = checkpointer ?? new MemorySaver();
    this.graph = this.buildGraph();

    this.initialized = true;
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
   * 自动注入暂停检查
   */
  private wrapNodeWithPauseCheck(node: GameNode): GameNode {
    return async (state: GameGraphState): Promise<GameGraphUpdate> => {
      await this.checkPause(state);
      return node(state);
    };
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

    gameLogger.debug(`配置验证通过: ${preset.name}`);
  }

  /**
   * 构建主图：固定拓扑 + 配置驱动的管道
   *
   * 主图拓扑（所有板子完全一致）：
   * START → init → night → check_win → day → check_win → (循环或结束) → game_end → END
   *
   * 板子差异体现在：
   * - nightPipeline：夜间具体执行哪些节点
   * - dayPipeline：白天具体执行哪些节点
   */
  private buildGraph() {
    if (!this.preset) {
      throw new Error('preset 未初始化');
    }

    const log = this.logger;

    const workflow = new StateGraph(GameStateAnnotation)
      // 1. 初始化节点
      .addNode(GAME_NODE.INIT, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('init', this.nodeContext);
        return await node(state);
      })

      // 2. 夜晚阶段
      .addNode(GAME_NODE.NIGHT, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('nightPipeline', this.nodeContext);
        return await node(state);
      })

      .addNode(GAME_NODE.DAY, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('dayPipeline', this.nodeContext);
        return await node(state);
      })

      .addNode(GAME_NODE.CHECK_WIN, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('checkWin', this.nodeContext);
        return await node(state);
      })

      // 5. 游戏结束节点
      .addNode(GAME_NODE.GAME_END, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('gameEnd', this.nodeContext);
        return await node(state);
      })

      // ========== 边定义（固定拓扑，所有板子完全一致，永不改变） ==========
      .addEdge(START, GAME_NODE.INIT)
      .addEdge(GAME_NODE.INIT, GAME_NODE.NIGHT)
      .addEdge(GAME_NODE.NIGHT, GAME_NODE.CHECK_WIN)

      // 关键：用内部标记 nextIsDay 驱动路由
      .addConditionalEdges(
        GAME_NODE.CHECK_WIN,
        (state: GameGraphState) => {
          if (state.isGameOver) {
            log.log(`对局结束，胜方: ${state.winner}`);
            return 'end';
          }

          // 检查中断：如果白天阶段触发了中断（如狼人自爆），直接跳转到夜晚
          if (
            state.interrupt?.type === 'wolf_explode' ||
            state.interrupt?.type === 'white_wolf_explode'
          ) {
            log.log(`[中断] 狼人自爆，立即进入黑夜`);
            return 'night';
          }

          // 根据内部标记决定下一步
          const nextIsDay = state.nextIsDay;
          return nextIsDay ? 'day' : 'night';
        },
        {
          end: GAME_NODE.GAME_END,
          day: GAME_NODE.DAY,
          night: GAME_NODE.NIGHT,
        },
      )

      .addEdge(GAME_NODE.DAY, GAME_NODE.CHECK_WIN)
      .addEdge(GAME_NODE.GAME_END, END);

    return workflow;
  }

  compile() {
    if (!this.graph || !this.checkpointer) {
      throw new Error('GameEngine 未初始化，请先调用 run() 方法');
    }
    return this.graph.compile({ checkpointer: this.checkpointer });
  }

  /**
   * 运行游戏主图
   * @param initialState 初始状态
   * @param maxRecursion 最大递归深度（默认 25，防止无限循环）
   * @param checkpointer 可选的 checkpointer（首次运行时设置）
   * @param preset 可选的板子配置（首次运行时设置）
   * @param signal AbortSignal 用于中断执行
   */
  async run(
    initialState: GameGraphState,
    maxRecursion = 25,
    checkpointer?: MemorySaver | PostgresSaver,
    preset?: GamePreset,
    signal?: AbortSignal,
  ) {
    // 延迟初始化：仅在首次 run 时执行
    this.initialize(checkpointer, preset);

    // 将 signal 注入到 nodeContext，传递给所有节点
    if (signal) {
      this.nodeContext.signal = signal;
    }

    const compiled = this.compile();
    gameLogger.log(`[游戏开始] gameId: ${initialState.gameId}`);

    try {
      // LangGraph 的 invoke 方法会自动检查 checkpoint：
      // - 如果存在相同 thread_id 的 checkpoint，会从断点恢复
      // - 如果不存在，会使用 initialState 开始执行
      const result = await compiled.invoke(initialState, {
        recursionLimit: maxRecursion,
        configurable: {
          thread_id: initialState.gameId, // 使用 gameId 作为 thread_id
        },
      });

      gameLogger.log(`[游戏结束] 胜方: ${result.winner ?? '未产生'}`);
      return result;
    } catch (error) {
      if (error instanceof GamePausedException) {
        throw error;
      }

      if (error instanceof GameAbortedException) {
        throw error;
      }

      throw error;
    } finally {
      this.pauseCheckCache = null;
      nodeRegistry.clearPauseCheckWrapper();
    }
  }
}

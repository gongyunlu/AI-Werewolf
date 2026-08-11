import { Logger, Injectable } from '@nestjs/common';
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { GameStateAnnotation, GAME_NODE, type GameGraphState, type GameGraphUpdate } from './types';
import { nodeRegistry } from '../nodes/node-registry';
import type { NodeContext } from '../nodes/node.types';
import type { GamePreset } from '../presets/game-presets';
import { DEFAULT_PRESET } from '../presets/game-presets';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import { PrismaService } from '@/prisma/prisma.service';
import { EventWriterService } from '../events/event-writer.service';

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

  /**
   * @param agentRuntime Agent 运行时服务
   * @param toolsFactory 工具工厂
   * @param prisma 数据库服务
   * @param eventWriter Event 写入服务
   */
  constructor(
    private readonly agentRuntime: AgentRuntimeService,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly prisma: PrismaService,
    private readonly eventWriter: EventWriterService,
  ) {
    // 仅构建节点上下文，延迟其他初始化
    this.nodeContext = {
      agentRuntime,
      toolsFactory,
      prisma,
      eventWriter,
    };
  }

  /**
   * 初始化游戏引擎（延迟初始化，仅在首次 run 时调用）
   */
  private initialize(checkpointer?: MemorySaver | PostgresSaver, preset?: GamePreset) {
    if (this.initialized) return;

    // 设置板子配置
    this.preset = preset ?? DEFAULT_PRESET;
    this.logger.log(`使用板子配置: ${this.preset.name}`);

    // 验证配置合法性
    this.validatePreset(this.preset);

    // 构建图
    this.checkpointer = checkpointer ?? new MemorySaver();
    this.graph = this.buildGraph();

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

    this.logger.log(`配置验证通过: ${preset.name}`);
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
    const preset = this.preset; // 提取到局部变量，避免类型问题

    const workflow = new StateGraph(GameStateAnnotation)
      // 1. 初始化节点
      .addNode(GAME_NODE.INIT, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const node = nodeRegistry.getNode('init', this.nodeContext);
        return await node(state);
      })

      // 2. 夜晚阶段：管道化执行所有夜间节点
      .addNode(GAME_NODE.NIGHT, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.NIGHT}] Day ${state.currentDay} 夜晚开始`);

        // 执行夜间管道
        let currentState = state;
        for (const nodeName of preset.nightPipeline) {
          const node = nodeRegistry.getNode(nodeName, this.nodeContext);
          const updates = await node(currentState);
          currentState = Object.assign({}, currentState, updates);
        }

        log.log(`[${GAME_NODE.NIGHT}] 夜晚阶段完成`);

        // 夜晚结束，标记下一阶段是白天
        return Object.assign({}, currentState, { nextIsDay: true });
      })

      // 3. 白天阶段：管道化执行所有白天节点
      .addNode(GAME_NODE.DAY, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[day] Day ${state.currentDay} 白天阶段`);

        // 执行白天管道
        let currentState = state;
        for (const nodeName of preset.dayPipeline) {
          const node = nodeRegistry.getNode(nodeName, this.nodeContext);
          const updates = await node(currentState);
          currentState = Object.assign({}, currentState, updates);

          // 如果游戏已结束，立即中断白天管道
          if (currentState.isGameOver) {
            log.log(`[day] 游戏结束，胜方: ${currentState.winner}`);
            break;
          }
        }

        log.log(`[day] 白天阶段完成`);

        // 白天结束，天数 +1，标记下一阶段是夜晚
        return Object.assign({}, currentState, {
          currentDay: currentState.currentDay + 1,
          nextIsDay: false,
        });
      })

      // 4. 胜负判定节点
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
   */
  async run(
    initialState: GameGraphState,
    maxRecursion = 25,
    checkpointer?: MemorySaver | PostgresSaver,
    preset?: GamePreset,
  ) {
    // 延迟初始化：仅在首次 run 时执行
    this.initialize(checkpointer, preset);

    const compiled = this.compile();
    this.logger.log('对局开始');

    const result = await compiled.invoke(initialState, {
      recursionLimit: maxRecursion,
      configurable: {
        thread_id: initialState.gameId, // 使用 gameId 作为 thread_id
      },
    });

    this.logger.log(`对局结束，胜方: ${result.winner ?? '未产生'}`);
    return result;
  }
}

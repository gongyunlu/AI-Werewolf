import { Logger } from '@nestjs/common';
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { GameStateAnnotation, GAME_NODE, type GameGraphState, type GameGraphUpdate } from './types';

/**
 * 狼人杀游戏引擎（LangGraph 主图）
 */
export class GameEngine {
  private readonly logger = new Logger(GameEngine.name);
  private graph: ReturnType<typeof GameEngine.prototype.buildGraph>;
  private checkpointer: MemorySaver | PostgresSaver;

  /**
   * @param checkpointer 可选的 checkpointer 实例，不传则使用 MemorySaver
   */
  constructor(checkpointer?: MemorySaver | PostgresSaver) {
    this.graph = this.buildGraph();
    this.checkpointer = checkpointer ?? new MemorySaver();
  }

  /**
   * 构建主图：定义节点、边、条件边
   * 流程：START → night → day_announce → check_win →(未结束)→ speech → vote → execute → night
   *                                                  →(已结束)→ END
   */
  private buildGraph() {
    const log = this.logger;

    const workflow = new StateGraph(GameStateAnnotation)
      // 夜晚阶段：狼刀 / 女巫用药 / 守卫守护 / 预言家查验
      .addNode(GAME_NODE.NIGHT, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.NIGHT}] Day ${state.currentDay} 夜晚开始`);
        return { currentPhase: 'night' };
      })
      // 天亮公布死讯
      .addNode(GAME_NODE.DAY_ANNOUNCE, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.DAY_ANNOUNCE}] Day ${state.currentDay} 公布夜晚死讯`);
        return { currentPhase: 'day_announce' };
      })
      // 发言阶段（后续会加入 Agent 发言逻辑，当前只打日志）
      .addNode(GAME_NODE.SPEECH, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.SPEECH}] Day ${state.currentDay} 白天发言`);
        return { currentPhase: 'speech' };
      })
      // 投票阶段（后续会加入计票逻辑，当前只打日志）
      .addNode(GAME_NODE.VOTE, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.VOTE}] Day ${state.currentDay} 投票`);
        return { currentPhase: 'vote' };
      })
      // 处决阶段：执行放逐，同时天数 +1（后续会加入死亡结算逻辑）
      .addNode(GAME_NODE.EXECUTE, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        log.log(`[${GAME_NODE.EXECUTE}] Day ${state.currentDay} 执行放逐`);
        return {
          currentPhase: 'execute',
          currentDay: state.currentDay + 1,
        };
      })
      // 胜负判定：标准屠边规则
      .addNode(GAME_NODE.CHECK_WIN, async (state: GameGraphState): Promise<GameGraphUpdate> => {
        const alive = state.players.filter((p) => p.isAlive);
        const aliveWerewolves = alive.filter((p) => p.faction === 'werewolf');
        const aliveGods = alive.filter((p) => p.faction === 'villager' && p.role !== 'villager');
        const aliveVillagers = alive.filter(
          (p) => p.faction === 'villager' && p.role === 'villager',
        );

        // 好人胜利：所有狼人死亡
        if (aliveWerewolves.length === 0) {
          log.log(`[${GAME_NODE.CHECK_WIN}] 好人阵营胜利（狼人全灭）`);
          return { currentPhase: 'check_win', isGameOver: true, winner: 'villager' };
        }

        // 狼人胜利（屠边）：所有神职死亡 OR 所有平民死亡
        if (aliveGods.length === 0 || aliveVillagers.length === 0) {
          log.log(
            `[${GAME_NODE.CHECK_WIN}] 狼人阵营胜利（屠边：${aliveGods.length === 0 ? '神职全灭' : '平民全灭'}）`,
          );
          return { currentPhase: 'check_win', isGameOver: true, winner: 'werewolf' };
        }

        log.log(`[${GAME_NODE.CHECK_WIN}] 游戏继续`);
        return { currentPhase: 'check_win' };
      })
      .addEdge(START, GAME_NODE.NIGHT)
      .addEdge(GAME_NODE.NIGHT, GAME_NODE.DAY_ANNOUNCE)
      .addEdge(GAME_NODE.DAY_ANNOUNCE, GAME_NODE.CHECK_WIN)
      .addConditionalEdges(
        GAME_NODE.CHECK_WIN,
        (state: GameGraphState) => (state.isGameOver ? 'end' : 'continue'),
        {
          end: END,
          continue: GAME_NODE.SPEECH,
        },
      )
      .addEdge(GAME_NODE.SPEECH, GAME_NODE.VOTE)
      .addEdge(GAME_NODE.VOTE, GAME_NODE.EXECUTE)
      .addEdge(GAME_NODE.EXECUTE, GAME_NODE.NIGHT);

    return workflow;
  }

  compile() {
    return this.graph.compile({ checkpointer: this.checkpointer });
  }

  /**
   * 运行游戏主图
   * @param initialState 初始状态
   * @param maxRecursion 最大递归深度（默认 25，防止无限循环）
   */
  async run(initialState: GameGraphState, maxRecursion = 25) {
    const compiled = this.compile();
    this.logger.log('对局开始');

    const result = await compiled.invoke(initialState, { recursionLimit: maxRecursion });

    this.logger.log(`对局结束，胜方: ${result.winner ?? '未产生'}`);
    return result;
  }
}

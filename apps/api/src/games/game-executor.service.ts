import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { AgentToolsFactory } from '../agent-runtime/tools/agent-tools.factory';
import { EventWriterService } from '../game-engine/events/event-writer.service';
import { GameEngine } from '../game-engine/core/game-engine';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import type { GameGraphState, PlayerState } from '../game-engine/core/types';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { GAME_STATUSES } from '@ai-werewolf/shared';

/**
 * 游戏执行服务
 *
 * 职责：
 * 1. 启动 LangGraph 游戏引擎
 * 2. 管理游戏状态的持久化
 * 3. 处理游戏执行过程中的异常
 */
@Injectable()
export class GameExecutorService {
  private readonly logger = new Logger(GameExecutorService.name);
  private checkpointer: PostgresSaver | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRuntime: AgentRuntimeService,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly eventWriter: EventWriterService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  /**
   * 初始化 PostgreSQL Checkpointer
   */
  private async ensureCheckpointer(): Promise<PostgresSaver> {
    if (!this.checkpointer) {
      const databaseUrl = this.configService.get('DATABASE_URL', { infer: true });
      this.checkpointer = PostgresSaver.fromConnString(databaseUrl);
      await this.checkpointer.setup();
      this.logger.log('PostgreSQL Checkpointer 初始化完成');
    }
    return this.checkpointer;
  }

  /**
   * 执行游戏对局
   *
   * @param gameId - 游戏对局ID
   * @returns 游戏最终状态
   */
  async executeGame(gameId: string): Promise<GameGraphState> {
    this.logger.log(`开始执行游戏对局: ${gameId}`);

    // 校验必需的依赖
    if (!this.agentRuntime || !this.toolsFactory) {
      throw new Error('AI 狼人杀项目必须配置 AgentRuntime 和 ToolsFactory');
    }

    // 1. 查询对局数据
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: { orderBy: { seatNo: 'asc' } },
        ruleset: true,
      },
    });

    if (!game) {
      throw new Error(`Game ${gameId} 不存在`);
    }

    // 2. 验证状态
    if (game.status !== GAME_STATUSES.RUNNING) {
      throw new Error(
        `Game ${gameId} 状态为 ${game.status}，只有 '${GAME_STATUSES.RUNNING}' 状态的对局可以执行`,
      );
    }

    const initialState = this.buildInitialState(game);
    const checkpointer = await this.ensureCheckpointer();
    const preset = ALL_PRESETS[game.ruleset.id];
    if (!preset) {
      throw new Error(`ruleset ${game.ruleset.id} 不支持，请检查数据一致性`);
    }

    // 3. 创建游戏引擎
    const engine = new GameEngine(
      this.agentRuntime,
      this.toolsFactory,
      this.prisma,
      this.eventWriter,
    );

    // 4. 运行游戏
    try {
      const finalState = await engine.run(initialState, 100, checkpointer, preset); // maxRecursion = 100

      // 5. 更新游戏结束状态
      await this.prisma.game.update({
        where: { id: gameId },
        data: {
          status: GAME_STATUSES.FINISHED,
          winnerFaction: finalState.winner ?? undefined,
          totalDays: finalState.currentDay,
          endedAt: new Date(),
        },
      });

      this.logger.log(`游戏对局 ${gameId} 执行完成，胜方: ${finalState.winner}`);
      return finalState;
    } catch (error) {
      this.logger.error(
        `游戏对局 ${gameId} 执行失败: ${error instanceof Error ? error.message : String(error)}`,
      );

      await this.prisma.game.update({
        where: { id: gameId },
        data: {
          status: GAME_STATUSES.ABORTED,
          endedAt: new Date(),
        },
      });

      throw error;
    }
  }

  /**
   * 构建初始游戏状态
   */
  private buildInitialState(game: {
    id: string;
    rulesetId: string;
    players: Array<{
      id: string;
      seatNo: number | null;
      role: string | null;
      faction: string | null;
      isSheriff: boolean;
    }>;
  }): GameGraphState {
    const playerStates: PlayerState[] = game.players.map((p) => ({
      id: p.id,
      seatNo: p.seatNo!,
      role: p.role as any,
      faction: p.faction as any,
      isAlive: true,
      deathDay: null,
      deathCause: null,
      protectedByGuard: false,
      hasAntidoteUsed: false,
      hasPoisonUsed: false,
      antidoteUsedOn: null,
      poisonUsedOn: null,
      isSheriff: p.isSheriff,
    }));

    return {
      gameId: game.id,
      currentDay: 1,
      currentPhase: 'night',
      players: playerStates,
      eventSequence: 0,
      wolfTarget: null,
      witchAntidoteTarget: null,
      witchPoisonTarget: null,
      guardTarget: null,
      seerCheckTarget: null,
      exileTarget: null,
      exileVoteCount: null,
      votingResults: new Map(),
      isGameOver: false,
      winner: null,
      loverPair: null,
      nightDeaths: null,
      seerCheckResult: null,
      interrupt: null,
      nextIsDay: false,
      speechOrder: null,
      speechDirection: null,
      speechStartSeatNo: null,
      speechOrderReason: null,
      rulesetId: game.rulesetId,
      pkCandidates: null,
      pkRound: 0,
      lastVoteResults: null,
    };
  }
}

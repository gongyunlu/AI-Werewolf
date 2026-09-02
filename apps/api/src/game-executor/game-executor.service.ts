import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import { EventWriterService } from '../game-engine/events/event-writer.service';
import { GameEngine } from '../game-engine/core/game-engine';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import type { GameGraphState, PlayerState } from '../game-engine/core/types';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import {
  GamePausedException,
  GameAbortedException,
} from '../game-engine/core/game-engine.exception';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { EventBusService } from '../event-bus/event-bus.service';
import { NodeRegistrar } from '../game-engine/nodes/node-registrar.service';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import { GameAnalysisService } from '../reflection/game-analysis.service';
import { LangfuseService } from '../observability/langfuse.service';
import { PromptService } from '../observability/prompt.service';
import { PostGameAnalysisError } from './game-executor.exception';

/**
 * 游戏执行服务
 *
 * 职责：
 * 1. 启动游戏引擎
 * 2. 处理游戏执行过程中的异常
 */
@Injectable()
export class GameExecutorService {
  private readonly logger = new Logger(GameExecutorService.name);
  private abortControllers = new Map<string, AbortController>(); // 存储每个游戏的 AbortController

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentRuntime: AgentRuntimeService,
    private readonly eventWriter: EventWriterService,
    private readonly configService: ConfigService<Env, true>,
    private readonly broadcaster: SseBroadcasterService,
    private readonly nodeRegistrar: NodeRegistrar,
    private readonly eventBus: EventBusService,
    private readonly speechSummarizer: SpeechSummarizerService,
    private readonly gameAnalysisService: GameAnalysisService,
    private readonly langfuse: LangfuseService,
    private readonly promptService: PromptService,
  ) {}

  /**
   * 执行游戏对局
   *
   * @param gameId - 游戏对局ID
   * @returns 游戏最终状态
   */
  async executeGame(gameId: string): Promise<GameGraphState> {
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
    const preset = ALL_PRESETS[game.ruleset.id];
    if (!preset) {
      throw new Error(`ruleset ${game.ruleset.id} 不支持，请检查数据一致性`);
    }

    await this.agentRuntime.validateRequiredSkills({
      rulesetId: game.ruleset.id,
      skillVersion: game.skillVersion,
      roles: game.players.map((player) => player.role).filter((role): role is string => !!role),
    });

    // 初始化 Redis sequence 计数器（处理 Redis 重启或游戏恢复场景）
    await this.eventWriter.initializeSequenceCounter(gameId);

    // 3. 创建游戏引擎
    const engine = new GameEngine(
      this.agentRuntime,
      this.prisma,
      this.eventWriter,
      this.broadcaster,
      this.nodeRegistrar,
      this.eventBus,
      this.configService,
      this.speechSummarizer,
      this.langfuse,
      this.promptService,
    );

    // 4. 创建 AbortController（用于中断游戏）
    const abortController = new AbortController();
    this.abortControllers.set(gameId, abortController);

    // 5. 运行游戏
    try {
      const finalState = await engine.run(initialState, preset, abortController.signal);

      // 6. 投递赛后分析。用显式错误类型告诉 Worker「引擎已完整返回，只需重试分析」，
      // 不能再靠数据库恰好已是 FINISHED 来猜测错误发生在哪个阶段。
      try {
        await this.analyzeFinishedGame(gameId);
      } catch (error) {
        throw new PostGameAnalysisError(gameId, error);
      }

      return finalState;
    } catch (error) {
      if (error instanceof GamePausedException) {
        return initialState;
      }

      if (error instanceof GameAbortedException) {
        return initialState;
      }
      throw error;
    } finally {
      this.abortControllers.delete(gameId);
    }
  }

  /** 为已经 FINISHED 的对局执行幂等结算并投递分析，供正常结束与队列重试共用。 */
  async analyzeFinishedGame(gameId: string): Promise<void> {
    try {
      const { judged, reflectPlanned } = await this.gameAnalysisService.analyzeGame(gameId);
      this.logger.log({ gameId, judged, reflectPlanned }, '已投递赛后分析任务');
    } catch (error) {
      this.logger.error(
        `结算/评估投递失败 gameId=${gameId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  /**
   * 中断游戏执行（立即终止 LLM 调用）
   *
   * @param gameId - 游戏对局ID
   * @returns 是否成功中断
   */
  abortGame(gameId: string): boolean {
    const abortController = this.abortControllers.get(gameId);
    if (abortController) {
      abortController.abort();
      return true;
    }
    return false;
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

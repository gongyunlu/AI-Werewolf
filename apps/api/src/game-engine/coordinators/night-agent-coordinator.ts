import { Injectable, Logger } from '@nestjs/common';
import { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import { PrismaService } from '@/prisma/prisma.service';
import type { GameGraphState } from '../core/types';
import { AGENT_SCENARIOS, ROLES } from '@ai-werewolf/shared';

/**
 * 夜间 Agent 协调器
 *
 * 职责：
 * 1. 并行派发所有夜间角色 Agent（狼队、预言家、女巫）
 * 2. 收集 Agent 决策结果
 * 3. 更新 GameState 的行动目标字段
 */
@Injectable()
export class NightAgentCoordinator {
  private readonly logger = new Logger(NightAgentCoordinator.name);

  constructor(
    private readonly agentRuntime: AgentRuntimeService,
    private readonly toolsFactory: AgentToolsFactory,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * 派发所有夜间 Agent 并收集决策结果
   *
   * 注意：按照狼人杀规则，夜间行动是串行的：
   * 1. 狼人刀人（先决定目标）
   * 2. 女巫用药（知道刀人目标后决策）
   * 3. 预言家查验（独立决策）
   *
   * @param state 当前游戏状态
   * @returns 更新后的 GameState（包含行动目标）
   */
  async dispatchNightAgents(state: GameGraphState): Promise<Partial<GameGraphState>> {
    const { gameId, players } = state;
    const alivePlayers = players.filter((p) => p.isAlive);

    this.logger.log(`[夜间派发] 开始派发夜间 Agent，存活玩家: ${alivePlayers.length}`);

    // 找出需要行动的角色
    const werewolves = alivePlayers.filter((p) => p.role === ROLES.WEREWOLF);
    const witch = alivePlayers.find((p) => p.role === ROLES.WITCH);
    const seer = alivePlayers.find((p) => p.role === ROLES.SEER);

    const updates: Partial<GameGraphState> = {};

    // 阶段 1：狼队讨论和刀人（优先执行）
    if (werewolves.length > 0) {
      try {
        const wolfResult = await this.dispatchWerewolfTeam(gameId, werewolves);
        if (wolfResult) {
          updates.wolfTarget = wolfResult.targetPlayerId;
          this.logger.log(`[夜间派发] 狼队决定刀: ${wolfResult.targetPlayerId}`);
        }
      } catch (error) {
        this.logger.warn(
          `[夜间派发] 狼队决策失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 阶段 2：女巫用药（知道刀人目标后决策）
    if (witch) {
      try {
        const witchResult = await this.dispatchWitch(
          gameId,
          witch.id,
          witch,
          updates.wolfTarget || null,
        );
        if (witchResult) {
          if (witchResult.antidoteTarget) {
            updates.witchAntidoteTarget = witchResult.antidoteTarget;
            this.logger.log(`[夜间派发] 女巫使用解药: ${witchResult.antidoteTarget}`);
          }
          if (witchResult.poisonTarget) {
            updates.witchPoisonTarget = witchResult.poisonTarget;
            this.logger.log(`[夜间派发] 女巫使用毒药: ${witchResult.poisonTarget}`);
          }
        }
      } catch (error) {
        this.logger.warn(
          `[夜间派发] 女巫决策失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 阶段 3：预言家查验（独立决策，可与女巫并行但为了简化逻辑仍串行）
    if (seer) {
      try {
        const seerResult = await this.dispatchSeer(gameId, seer.id);
        if (seerResult) {
          updates.seerCheckTarget = seerResult.targetSeatNo;
          this.logger.log(`[夜间派发] 预言家查验: ${seerResult.targetSeatNo} 号位`);
        }
      } catch (error) {
        this.logger.warn(
          `[夜间派发] 预言家决策失败: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(`[夜间派发] 所有 Agent 决策完成`);

    return updates;
  }

  /**
   * 派发狼队 Agent（讨论并决定刀人目标）
   */
  private async dispatchWerewolfTeam(
    gameId: string,
    werewolves: Array<{ id: string }>,
  ): Promise<{ targetPlayerId: string } | null> {
    // 简化逻辑：只派发第一个狼人作为代表
    // TODO: 支持多个狼人协商（需要统计所有狼人的 propose_kill 投票）
    const representative = werewolves[0];

    const tools = this.toolsFactory.buildNightActionTools(
      { gameId, currentPlayerId: representative.id },
      'werewolf',
    );

    const result = await this.agentRuntime.run({
      gameId,
      playerId: representative.id,
      scenario: AGENT_SCENARIOS.NIGHT_ACTION,
      availableTools: tools,
      maxIterations: 5,
    });

    if (!result.success || !result.result) {
      this.logger.warn(`[狼队] Agent 执行失败: ${result.error}`);
      return null;
    }

    // 解析工具调用结果
    const toolResult = result.result as any;

    if (toolResult.action === 'propose_kill') {
      // propose_kill 返回座位号，需要转换为玩家 ID
      // 从数据库查询座位号对应的玩家 ID
      const player = await this.prisma.player.findFirst({
        where: {
          gameId,
          seatNo: toolResult.targetSeatNo,
        },
      });

      if (!player) {
        this.logger.warn(`[狼队] 未找到座位号 ${toolResult.targetSeatNo} 对应的玩家`);
        return null;
      }

      return { targetPlayerId: player.id };
    }

    this.logger.warn(`[狼队] Agent 未调用 propose_kill 工具`);
    return null;
  }

  /**
   * 派发预言家 Agent（决定查验目标）
   */
  private async dispatchSeer(
    gameId: string,
    seerId: string,
  ): Promise<{ targetSeatNo: number } | null> {
    const tools = this.toolsFactory.buildNightActionTools(
      { gameId, currentPlayerId: seerId },
      'seer',
    );

    const result = await this.agentRuntime.run({
      gameId,
      playerId: seerId,
      scenario: AGENT_SCENARIOS.NIGHT_ACTION,
      availableTools: tools,
      maxIterations: 5,
    });

    if (!result.success || !result.result) {
      this.logger.warn(`[预言家] Agent 执行失败: ${result.error}`);
      return null;
    }

    // 解析工具调用结果
    const toolResult = result.result as any;

    if (toolResult.action === 'check_identity') {
      return { targetSeatNo: toolResult.targetSeatNo };
    }

    this.logger.warn(`[预言家] Agent 未调用 check_identity 工具`);
    return null;
  }

  /**
   * 派发女巫 Agent（决定是否用药）
   *
   * @param gameId 游戏 ID
   * @param witchId 女巫玩家 ID
   * @param witchState 女巫状态（药剂使用情况）
   * @param _wolfTarget 狼人刀人目标（女巫可以知道这个信息，TODO: 注入到 System Prompt）
   */
  private async dispatchWitch(
    gameId: string,
    witchId: string,
    witchState: { hasAntidoteUsed: boolean; hasPoisonUsed: boolean },
    _wolfTarget: string | null,
  ): Promise<{ antidoteTarget?: string; poisonTarget?: string } | null> {
    // 根据女巫药剂使用状态，过滤可用工具
    let tools = this.toolsFactory.buildNightActionTools(
      { gameId, currentPlayerId: witchId },
      'witch',
    );

    // 过滤掉已使用的药剂对应的工具
    if (witchState.hasAntidoteUsed) {
      tools = tools.filter((t) => t.name !== 'use_antidote');
    }
    if (witchState.hasPoisonUsed) {
      tools = tools.filter((t) => t.name !== 'use_poison');
    }

    // TODO: 将 wolfTarget 信息注入到 System Prompt 中
    // 让女巫知道今晚被刀的目标是谁
    // 当前先不传入，后续优化

    const result = await this.agentRuntime.run({
      gameId,
      playerId: witchId,
      scenario: AGENT_SCENARIOS.NIGHT_ACTION,
      availableTools: tools,
      maxIterations: 5,
    });

    if (!result.success || !result.result) {
      this.logger.warn(`[女巫] Agent 执行失败: ${result.error}`);
      return null;
    }

    // 解析工具调用结果
    const toolResult = result.result as any;

    if (toolResult.action === 'use_antidote') {
      // use_antidote 返回玩家 ID
      return { antidoteTarget: toolResult.targetPlayerId };
    }

    if (toolResult.action === 'use_poison') {
      // use_poison 返回玩家 ID
      return { poisonTarget: toolResult.targetPlayerId };
    }

    // skip_action 或其他情况，返回空
    return null;
  }
}

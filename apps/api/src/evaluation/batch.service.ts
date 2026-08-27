import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GamesService } from '../games/games.service';
import { GameLaunchService } from '../games/game-launch.service';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import type { BatchRunDto } from './dto/batch-run.dto';

/** 随机抽样 n 个元素 */
function sampleN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * 批量跑局
 */
@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gamesService: GamesService,
    private readonly gameLaunch: GameLaunchService,
  ) {}

  async runBatch(dto: BatchRunDto) {
    const ruleset = await this.prisma.ruleset.findUnique({ where: { id: dto.rulesetId } });
    if (!ruleset) {
      throw new BadRequestException(`Ruleset ${dto.rulesetId} 不存在`);
    }
    if (!ALL_PRESETS[dto.rulesetId]) {
      throw new BadRequestException(
        `Ruleset ${dto.rulesetId} 不支持，当前仅支持: ${Object.keys(ALL_PRESETS).join(', ')}`,
      );
    }

    const pool = await this.resolveAgentPool(dto.agentIds);
    if (pool.length < ruleset.playerCount) {
      throw new BadRequestException(
        `Agent 池数量(${pool.length}) 小于 Ruleset.playerCount(${ruleset.playerCount})`,
      );
    }

    const gameIds: string[] = [];
    for (let i = 0; i < dto.count; i++) {
      const agentIds = dto.shuffleAgents
        ? sampleN(pool, ruleset.playerCount)
        : pool.slice(0, ruleset.playerCount);
      const game = await this.gamesService.createGame({ rulesetId: dto.rulesetId, agentIds });
      await this.gameLaunch.start(game.id);
      gameIds.push(game.id);
    }

    this.logger.log({ rulesetId: dto.rulesetId, count: gameIds.length }, '批量跑局已投递');
    return { count: gameIds.length, gameIds, rulesetId: dto.rulesetId };
  }

  private async resolveAgentPool(agentIds?: string[]): Promise<string[]> {
    if (agentIds && agentIds.length > 0) {
      const agents = await this.prisma.agent.findMany({ where: { id: { in: agentIds } } });
      if (agents.length !== agentIds.length) {
        const found = new Set(agents.map((a) => a.id));
        const missing = agentIds.filter((id) => !found.has(id));
        throw new BadRequestException(`以下 Agent 不存在：${missing.join(', ')}`);
      }
      const inactive = agents.filter((a) => !a.isActive);
      if (inactive.length > 0) {
        throw new BadRequestException(
          `以下 Agent 已停用：${inactive.map((a) => a.name).join(', ')}`,
        );
      }
      return agentIds;
    }

    const agents = await this.prisma.agent.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    return agents.map((a) => a.id);
  }
}

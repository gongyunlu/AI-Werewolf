import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GamesService } from '../games/games.service';
import { GameLaunchService } from '../games/game-launch.service';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import type { BatchRunDto } from './dto/batch-run.dto';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { RulesetDefinitionSchema } from '../games/ruleset-definition';
import { MemoryService } from '../memory/memory.service';
import { EmbeddingService } from '../memory/embedding.service';
import { GlobalMemoryService } from '../memory/global-memory.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { PromptService } from '../observability/prompt.service';
import { assignRolesAndSeats } from '../game-engine/rules/role-assignment';
import type { ExperimentSnapshot } from './experiment-snapshot';
import type { Env } from '../config/env.validation';

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
    private readonly memory: MemoryService,
    private readonly embedding: EmbeddingService,
    private readonly globalMemory: GlobalMemoryService,
    private readonly skills: SkillLoaderService,
    private readonly prompts: PromptService,
    private readonly config: ConfigService<Env, true>,
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

    if (dto.experiment) return this.runPaired(dto, pool, ruleset);
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

  private async runPaired(
    dto: BatchRunDto,
    pool: string[],
    ruleset: { playerCount: number; definition: unknown },
  ) {
    const definition = RulesetDefinitionSchema.parse(ruleset.definition);
    const agents = await this.prisma.agent.findMany({ where: { id: { in: pool } } });
    const skillIds = [
      `rulesets/${dto.rulesetId}`,
      ...new Set(definition.roles.map(({ role }) => `roles/${role}`)),
      'scenarios/night-action',
      'scenarios/day-speech',
      'scenarios/vote',
      'scenarios/last-words',
      'scenarios/sheriff-decide-order',
    ];
    const [memories, globalPatterns, prompts, chunks, skillEntries] = await Promise.all([
      this.memory.captureExperimentMemories(pool),
      this.globalMemory.retrieveActivePatterns(),
      this.prompts.captureSnapshot(),
      this.prisma.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM knowledge_chunks WHERE is_active AND embedding IS NOT NULL AND applicability->>'reviewed' = 'true' AND applicability->'rulesets' ? ${dto.rulesetId} AND embedding_model = ${this.embedding.model} AND embedding_dimension = ${this.embedding.dimension} ORDER BY id`,
      Promise.all(
        skillIds.map(
          async (id) => [id, (await this.skills.loadRequiredSkill(id, 'v1')).content] as const,
        ),
      ),
    ]);
    if (!chunks.length)
      throw new BadRequestException('没有该板子已审阅且已向量化的攻略，不能创建空处理组实验');
    const experimentId = randomUUID();
    const capturedAt = new Date().toISOString();
    const roleContexts = Object.fromEntries(
      ['system-prompt-template', 'default', 'werewolf', 'seer', 'witch', 'villager'].map((name) => [
        name,
        readFileSync(join(__dirname, '../role-contexts', `${name}.md`), 'utf8'),
      ]),
    );
    const pairs: Array<{ pairId: string; on: string; off: string }> = [];
    const gameIds: string[] = [];
    for (let i = 0; i < dto.count; i++) {
      const agentIds = dto.shuffleAgents
        ? sampleN(pool, ruleset.playerCount)
        : pool.slice(0, ruleset.playerCount);
      const assignments = assignRolesAndSeats(definition.roles, agentIds).map((a) => {
        const agent = agents.find((candidate) => candidate.id === a.agentId)!;
        return Object.assign(a, {
          modelName: agent.defaultModelName,
          memoryLabel: agent.memoryLabel,
        });
      });
      const pairId = randomUUID();
      const pair = { pairId, on: '', off: '' };
      const arms: Array<'on' | 'off'> = i % 2 ? ['off', 'on'] : ['on', 'off'];
      for (const arm of arms) {
        const snapshot: ExperimentSnapshot = {
          version: 1,
          experimentId,
          pairId,
          arm,
          capturedAt,
          memories,
          globalPatterns: globalPatterns.map(({ title, content }) => ({ title, content })),
          prompts,
          knowledgeChunkIds: chunks.map((c) => c.id),
          skills: Object.fromEntries(skillEntries),
          embeddingModel: this.embedding.model,
          judgeModel: this.config.get('JUDGE_MODEL') || this.config.get('ARK_DEFAULT_MODEL'),
          auxiliaryModel: this.config.get('ARK_DEFAULT_MODEL'),
          roleContexts,
          assignments,
        };
        const game = await this.gamesService.createGame(
          { rulesetId: dto.rulesetId, agentIds },
          snapshot,
        );
        await this.gamesService.initializeGame(game.id);
        pair[arm] = game.id;
        gameIds.push(game.id);
      }
      pairs.push(pair);
    }
    if (dto.experiment?.start) for (const gameId of gameIds) await this.gameLaunch.start(gameId);
    return {
      experimentId,
      count: gameIds.length,
      gameIds,
      pairs,
      rulesetId: dto.rulesetId,
      started: dto.experiment?.start ?? false,
    };
  }
}

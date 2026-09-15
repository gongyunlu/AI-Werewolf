import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateGameDto } from './dto/create-game.dto';
import type { QueryGamesDto } from './dto/query-games.dto';
import { RulesetDefinitionSchema } from './ruleset-definition';
import { assignRolesAndSeats } from '../game-engine/rules/role-assignment';
import { readExperiment, type ExperimentSnapshot } from '../evaluation/experiment-snapshot';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';
import { AGENT_GAME_OMIT } from '../agents/agents.service';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

const SKILL_VERSION = 'v1';

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameExecutor: GameExecutorService,
    private readonly broadcaster: SseBroadcasterService,
    private readonly configService: ConfigService<Env, true>,
  ) {}

  /**
   * 查询游戏对局列表
   */
  async queryGames(dto: QueryGamesDto) {
    const { page, pageSize, status, rulesetId, sortBy, sortOrder } = dto;
    const skip = (page - 1) * pageSize;

    const where: any = {};
    if (status && status.length > 0) {
      where.status = { in: status };
    }
    if (rulesetId) {
      where.rulesetId = rulesetId;
    }

    const [items, total] = await Promise.all([
      this.prisma.game.findMany({
        where,
        omit: { experiment: true },
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
        include: {
          ruleset: { select: { id: true, name: true } },
          players: {
            select: {
              id: true,
              seatNo: true,
              role: true,
              faction: true,
              deathDay: true,
              deathCause: true,
              displayName: true,
              modelName: true,
              isSheriff: true,
            },
            orderBy: { seatNo: 'asc' },
          },
        },
      }),
      this.prisma.game.count({ where }),
    ]);

    // 复盘正文非空即视为已分析。单独查而非 include：narrative 是整段 JSON，
    // 挂进每一行会把列表响应撑大，而列表只需要一个布尔值
    const analyzed = await this.prisma.gameSummary.findMany({
      where: { gameId: { in: items.map((game) => game.id) }, narrative: { not: null } },
      select: { gameId: true },
    });
    const analyzedIds = new Set(analyzed.map((row) => row.gameId));
    // 仅取分组标签，避免把包含向量与提示词的整个实验快照发送到列表。
    const experimentArms = await this.prisma.$queryRaw<Array<{ id: string; arm: string }>>`
      SELECT id, experiment->>'arm' AS arm FROM games
      WHERE id = ANY(${items.map((game) => game.id)}::uuid[]) AND experiment IS NOT NULL
    `;
    const armById = new Map(experimentArms.map((row) => [row.id, row.arm]));

    return {
      items: items.map((game) =>
        Object.assign(game, {
          analyzed: analyzedIds.has(game.id),
          experimentArm: armById.get(game.id) ?? null,
        }),
      ),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 创建游戏对局（对局大厅）
   *
   * @param dto - 请求参数
   * @returns 创建的游戏记录，包含所有玩家信息（角色未分配）
   * @throws {BadRequestException} 当规则集不存在、Agent数量不匹配、Agent重复或Agent不存在/已停用时抛出
   */
  async createGame(dto: CreateGameDto, experiment?: ExperimentSnapshot) {
    // 1. 校验 Ruleset
    const ruleset = await this.prisma.ruleset.findUnique({ where: { id: dto.rulesetId } });
    if (!ruleset) {
      throw new BadRequestException(`Ruleset ${dto.rulesetId} 不存在`);
    }

    if (!ALL_PRESETS[ruleset.id]) {
      throw new BadRequestException(
        `Ruleset ${dto.rulesetId} 不支持，当前仅支持以下 ruleset: ${Object.keys(ALL_PRESETS).join(', ')}`,
      );
    }

    // 2. 校验 Agent 数量
    if (dto.agentIds.length !== ruleset.playerCount) {
      throw new BadRequestException(
        `agentIds 数量(${dto.agentIds.length}) 与 Ruleset.playerCount(${ruleset.playerCount}) 不匹配`,
      );
    }

    // 3. 校验 Agent 无重复
    if (new Set(dto.agentIds).size !== dto.agentIds.length) {
      throw new BadRequestException('agentIds 中存在重复 Agent，同一局同一 Agent 不允许占多个座位');
    }

    // 4. 校验 Agent 存在性和状态
    const agents = await this.prisma.agent.findMany({ where: { id: { in: dto.agentIds } } });
    if (agents.length !== dto.agentIds.length) {
      const foundIds = new Set(agents.map((a) => a.id));
      const missing = dto.agentIds.filter((id) => !foundIds.has(id));
      throw new BadRequestException(`以下 Agent 不存在：${missing.join(', ')}`);
    }
    const inactive = agents.filter((a) => !a.isActive);
    if (inactive.length > 0) {
      throw new BadRequestException(
        `以下 Agent 已停用，无法加入对局：${inactive.map((a) => a.name).join(', ')}`,
      );
    }

    // 创建对局和玩家记录（不分配座次和角色）
    return this.prisma.game.create({
      omit: { experiment: true },
      data: {
        rulesetId: ruleset.id,
        ...(experiment ? { experiment: JSON.parse(JSON.stringify(experiment)) } : {}),
        skillVersion: SKILL_VERSION,
        status: GAME_STATUSES.CREATED, // 状态：已创建
        players: {
          create: dto.agentIds.map((agentId) => {
            const agent = agents.find((a) => a.id === agentId)!;
            return {
              agent: { connect: { id: agentId } },
              seatNo: null, // 未分配座次
              role: null, // 未分配角色
              faction: null, // 未分配阵营
              displayName: agent.name,
              modelName:
                experiment?.assignments.find((a) => a.agentId === agentId)?.modelName ??
                agent.defaultModelName,
              memoryLabelSnapshot:
                experiment?.assignments.find((a) => a.agentId === agentId)?.memoryLabel ??
                agent.memoryLabel,
              // 默认接入也冻结实际地址，恢复时只允许同端点更新密钥。
              accessBaseUrl: agent.baseUrl ?? this.configService.get('ARK_BASE_URL'),
              accessUsesDefault: !agent.baseUrl,
            };
          }),
        },
      },
      include: {
        players: {
          include: { agent: { omit: AGENT_GAME_OMIT } },
        },
      },
    });
  }

  /**
   * 初始化游戏对局（分配座次和角色）
   *
   * @param gameId - 游戏对局ID
   * @returns 更新后的游戏记录
   * @throws {NotFoundException} 当游戏对局不存在时抛出
   * @throws {BadRequestException} 当游戏对局状态不是 'created' 时抛出
   */
  async initializeGame(gameId: string) {
    // 1. 查询对局和规则集
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: { include: { agent: { omit: AGENT_GAME_OMIT } } },
        ruleset: true,
      },
    });

    if (!game) {
      throw new NotFoundException(`Game ${gameId} 不存在`);
    }

    if (game.status !== GAME_STATUSES.CREATED) {
      throw new BadRequestException(
        `Game ${gameId} 状态为 ${game.status}，只有 '${GAME_STATUSES.CREATED}' 状态的对局可以初始化`,
      );
    }

    // 2. 解析规则集
    const parsed = RulesetDefinitionSchema.safeParse(game.ruleset.definition);
    if (!parsed.success) {
      throw new BadRequestException(`Ruleset ${game.ruleset.id} 的 definition 结构非法`);
    }
    const roleAssignments = parsed.data.roles;

    // 3. 随机分配座次和角色
    const agentIds = game.players.map((p) => p.agent.id);
    const assignments =
      readExperiment(game.experiment)?.assignments ??
      assignRolesAndSeats(roleAssignments, agentIds);

    // 4. 批量更新 Player 记录 + 更新 Game 状态（事务内保证原子性）
    return this.prisma.$transaction(async (tx) => {
      await Promise.all(
        assignments.map((assignment) => {
          const player = game.players.find((p) => p.agent.id === assignment.agentId)!;
          return tx.player.update({
            where: { id: player.id },
            data: {
              seatNo: assignment.seatNo,
              role: assignment.role,
              faction: assignment.faction,
            },
          });
        }),
      );

      // 5. 更新 Game 状态
      return tx.game.update({
        where: { id: gameId },
        data: { status: GAME_STATUSES.INITIALIZED },
        omit: { experiment: true },
        include: {
          players: {
            orderBy: { seatNo: 'asc' },
            include: { agent: { omit: AGENT_GAME_OMIT } },
          },
        },
      });
    });
  }

  /**
   * 根据ID获取游戏对局详情
   *
   * @param id - 游戏对局ID
   * @returns 游戏对局记录，包含所有玩家信息
   * @throws {NotFoundException} 当游戏对局不存在时抛出
   */
  async getGameById(id: string) {
    const game = await this.prisma.game.findUnique({
      where: { id },
      omit: { experiment: true },
      include: {
        ruleset: { select: { id: true, name: true } },
        players: {
          select: {
            id: true,
            seatNo: true,
            role: true,
            faction: true,
            deathDay: true,
            deathCause: true,
            displayName: true,
            modelName: true,
            isSheriff: true,
          },
          orderBy: { seatNo: 'asc' },
        },
      },
    });
    if (!game) {
      throw new NotFoundException(`Game ${id} 不存在`);
    }
    return game;
  }

  /**
   * 开始游戏对局（更新状态为 running）
   *
   * @param gameId - 游戏对局ID
   * @returns 更新后的游戏记录
   * @throws {NotFoundException} 当游戏对局不存在时抛出
   * @throws {BadRequestException} 当游戏对局状态不是 'initialized' 时抛出
   */
  async startGame(gameId: string) {
    // 1. 查询对局
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: { include: { agent: { omit: AGENT_GAME_OMIT } } },
        ruleset: true,
      },
    });

    if (!game) {
      throw new NotFoundException(`Game ${gameId} 不存在`);
    }

    // 2. 如果是 created 状态，先自动初始化（分配座次和角色）
    if (game.status === GAME_STATUSES.CREATED) {
      const parsed = RulesetDefinitionSchema.safeParse(game.ruleset.definition);
      if (!parsed.success) {
        throw new BadRequestException(`Ruleset ${game.ruleset.id} 的 definition 结构非法`);
      }
      const agentIds = game.players.map((p) => p.agent.id);
      const assignments =
        readExperiment(game.experiment)?.assignments ??
        assignRolesAndSeats(parsed.data.roles, agentIds);
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.game.updateMany({
          where: { id: gameId, status: GAME_STATUSES.CREATED },
          data: { status: GAME_STATUSES.INITIALIZED },
        });
        if (claimed.count === 0) return;

        await Promise.all(
          assignments.map((assignment) => {
            const player = game.players.find((p) => p.agent.id === assignment.agentId)!;
            return tx.player.update({
              where: { id: player.id },
              data: {
                seatNo: assignment.seatNo,
                role: assignment.role,
                faction: assignment.faction,
              },
            });
          }),
        );
      });
    }

    // 3. 原子抢占 initialized -> running，避免并发 start 相互覆盖或重复入队
    const started = await this.prisma.game.updateMany({
      where: { id: gameId, status: GAME_STATUSES.INITIALIZED },
      data: { status: GAME_STATUSES.RUNNING },
    });
    if (started.count !== 1) {
      const current = await this.prisma.game.findUnique({
        where: { id: gameId },
        select: { status: true },
      });
      throw new BadRequestException(`Game ${gameId} 状态为 ${current?.status}，无法开始对局`);
    }

    // 4. 初始化 SSE 广播流
    this.broadcaster.getOrCreate(gameId);

    // 5. 返回启动后的完整对局
    return this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      omit: { experiment: true },
      include: {
        players: { orderBy: { seatNo: 'asc' }, include: { agent: { omit: AGENT_GAME_OMIT } } },
      },
    });
  }

  /** 入队失败时撤销 running 状态，使已初始化对局可以安全重试启动。 */
  async rollbackFailedStart(gameId: string): Promise<void> {
    await this.prisma.game.updateMany({
      where: { id: gameId, status: GAME_STATUSES.RUNNING },
      data: { status: GAME_STATUSES.INITIALIZED },
    });
    this.broadcaster.complete(gameId);
  }

  /**
   * 获取所有需要恢复的对局
   */
  async getPendingRecoveryGames() {
    return this.prisma.game.findMany({
      where: { status: GAME_STATUSES.PENDING_RECOVERY },
      select: {
        id: true,
        startedAt: true,
        rulesetId: true,
      },
      orderBy: { startedAt: 'asc' },
    });
  }

  /**
   * 暂停对局
   */
  async pauseGame(gameId: string) {
    throw new NotImplementedException(`对局 ${gameId} 暂不支持暂停`);
  }

  /**
   * 更新游戏状态
   */
  async updateGameStatus(gameId: string, status: string) {
    return this.prisma.game.update({
      where: { id: gameId },
      data: { status },
    });
  }

  /**
   * 继续对局
   */
  async resumeGame(gameId: string) {
    throw new NotImplementedException(`对局 ${gameId} 暂不支持恢复执行`);
  }

  /**
   * 取消对局
   */
  async cancelGame(gameId: string): Promise<boolean> {
    const game = await this.getGameById(gameId);

    if (game.status === GAME_STATUSES.FINISHED || game.status === GAME_STATUSES.ABORTED) {
      throw new BadRequestException(`对局已结束，无法取消`);
    }

    // 条件更新会在数据库持锁后复核，不能覆盖读取状态后刚提交的正常终局。
    const cancelled = await this.prisma.game.updateMany({
      where: { id: gameId, status: { notIn: [GAME_STATUSES.FINISHED, GAME_STATUSES.ABORTED] } },
      data: { status: GAME_STATUSES.ABORTED, endedAt: new Date() },
    });
    if (!cancelled.count) throw new BadRequestException('对局已结束，无法取消');

    this.gameExecutor.abortGame(gameId);
    this.broadcaster.emit(gameId, { type: 'game.finished', winner: 'unknown' });
    this.broadcaster.complete(gameId);

    return true;
  }

  /**
   * 清理所有待恢复对局（标记为 aborted）
   */
  async clearPendingRecovery(): Promise<number> {
    const result = await this.prisma.game.updateManyAndReturn({
      where: { status: GAME_STATUSES.PENDING_RECOVERY },
      data: {
        status: GAME_STATUSES.ABORTED,
        endedAt: new Date(),
      },
      select: { id: true },
    });
    for (const game of result) this.broadcaster.complete(game.id);
    return result.length;
  }
}

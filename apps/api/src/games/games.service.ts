import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateGameDto } from './dto/create-game.dto';
import type { QueryGamesDto } from './dto/query-games.dto';
import { RulesetDefinitionSchema } from './ruleset-definition';
import { assignRolesAndSeats } from '../game-engine/rules/role-assignment';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { GameExecutorService } from '../game-executor/game-executor.service';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';

const SKILL_VERSION = 'v1';

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameExecutor: GameExecutorService,
    private readonly broadcaster: SseBroadcasterService,
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

    return {
      items,
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
  async createGame(dto: CreateGameDto) {
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
      data: {
        rulesetId: ruleset.id,
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
              modelName: agent.defaultModelName,
              memoryLabelSnapshot: agent.memoryLabel,
            };
          }),
        },
      },
      include: {
        players: {
          include: { agent: true },
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
        players: { include: { agent: true } },
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
    const assignments = assignRolesAndSeats(roleAssignments, agentIds);

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
        include: {
          players: {
            orderBy: { seatNo: 'asc' },
            include: { agent: true },
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
        players: { include: { agent: true } },
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
      const assignments = assignRolesAndSeats(parsed.data.roles, agentIds);
      await this.prisma.$transaction(async (tx) => {
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
        await tx.game.update({
          where: { id: gameId },
          data: { status: GAME_STATUSES.INITIALIZED },
        });
      });
    }

    // 3. 校验状态（经过初始化后应为 initialized）
    const refreshed = await this.prisma.game.findUnique({ where: { id: gameId } });
    if (refreshed?.status !== GAME_STATUSES.INITIALIZED) {
      throw new BadRequestException(`Game ${gameId} 状态为 ${refreshed?.status}，无法开始对局`);
    }

    // 4. 初始化 SSE 广播流
    this.broadcaster.getOrCreate(gameId);

    // 5. 更新状态为 running
    return this.prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.RUNNING },
      include: {
        players: { orderBy: { seatNo: 'asc' }, include: { agent: true } },
      },
    });
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
    const game = await this.getGameById(gameId);

    if (game.status !== GAME_STATUSES.RUNNING) {
      throw new BadRequestException(`只能暂停 running 状态的对局，当前状态: ${game.status}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.game.update({
        where: { id: gameId },
        data: { status: GAME_STATUSES.PAUSED },
      });
    });
    this.gameExecutor.abortGame(gameId);
    return this.prisma.game.findUnique({ where: { id: gameId } });
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
    const game = await this.getGameById(gameId);

    if (game.status !== GAME_STATUSES.PAUSED) {
      throw new BadRequestException(`只能继续 paused 状态的对局，当前状态: ${game.status}`);
    }

    return this.prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.RUNNING },
    });
  }

  /**
   * 取消对局
   */
  async cancelGame(gameId: string): Promise<boolean> {
    const game = await this.getGameById(gameId);

    if (game.status === GAME_STATUSES.FINISHED || game.status === GAME_STATUSES.ABORTED) {
      throw new BadRequestException(`对局已结束，无法取消`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.game.update({
        where: { id: gameId },
        data: {
          status: GAME_STATUSES.ABORTED,
          endedAt: new Date(),
        },
      });
    });

    this.gameExecutor.abortGame(gameId);

    return true;
  }

  /**
   * 清理所有待恢复对局（标记为 aborted）
   */
  async clearPendingRecovery(): Promise<number> {
    const result = await this.prisma.game.updateMany({
      where: { status: GAME_STATUSES.PENDING_RECOVERY },
      data: {
        status: GAME_STATUSES.ABORTED,
        endedAt: new Date(),
      },
    });
    return result.count;
  }
}

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateGameDto } from './dto/create-game.dto';
import { RulesetDefinitionSchema } from './ruleset-definition';
import { assignRolesAndSeats } from '../game-engine/rules/role-assignment';
import { GameExecutorService } from './game-executor.service';
import { ALL_PRESETS } from '../game-engine/presets/game-presets';
import { GAME_STATUSES } from '@ai-werewolf/shared';

const SKILL_VERSION = 'v1';

@Injectable()
export class GamesService {
  private readonly logger = new Logger(GamesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gameExecutor: GameExecutorService,
  ) {}

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

    // 4. 批量更新 Player 记录
    await Promise.all(
      assignments.map((assignment) => {
        const player = game.players.find((p) => p.agent.id === assignment.agentId)!;
        return this.prisma.player.update({
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
    return this.prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.INITIALIZED },
      include: {
        players: {
          orderBy: { seatNo: 'asc' },
          include: { agent: true },
        },
      },
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
      include: { players: { orderBy: { seatNo: 'asc' }, include: { agent: true } } },
    });
    if (!game) {
      throw new NotFoundException(`Game ${id} 不存在`);
    }
    return game;
  }

  /**
   * 开始游戏对局（启动游戏引擎）
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
        players: { orderBy: { seatNo: 'asc' } },
      },
    });

    if (!game) {
      throw new NotFoundException(`Game ${gameId} 不存在`);
    }

    if (game.status !== GAME_STATUSES.INITIALIZED) {
      throw new BadRequestException(
        `Game ${gameId} 状态为 ${game.status}，只有 '${GAME_STATUSES.INITIALIZED}' 状态的对局可以开始`,
      );
    }

    // 2. 更新状态为 running
    await this.prisma.game.update({
      where: { id: gameId },
      data: { status: GAME_STATUSES.RUNNING },
    });

    // 3. 启动游戏引擎（异步执行）
    // 注意：这里不 await，让游戏在后台执行
    this.gameExecutor.executeGame(gameId).catch((error) => {
      this.logger.error(`游戏对局 ${gameId} 执行失败:`, error);
    });

    // 4. 立即返回（不等待游戏结束）
    return this.prisma.game.findUnique({
      where: { id: gameId },
      include: {
        players: { orderBy: { seatNo: 'asc' }, include: { agent: true } },
      },
    });
  }
}

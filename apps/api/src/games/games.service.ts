import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateGameDto } from './dto/create-game.dto';
import { type RoleAssignment, RulesetDefinitionSchema } from './ruleset-definition';

// 硬编码的技能版本号，Phase 8+ 引入 Agent 提示词版本管理后再改
const SKILL_VERSION = 'v1';

@Injectable()
export class GamesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 创建游戏对局
   *
   * @param dto - 请求参数
   * @returns 创建的游戏记录，包含所有玩家信息
   * @throws {BadRequestException} 当规则集不存在、规则集定义非法、角色数量不匹配、Agent数量不匹配、Agent重复或Agent不存在/已停用时抛出
   */
  async createGame(dto: CreateGameDto) {
    const ruleset = await this.prisma.ruleset.findUnique({ where: { id: dto.rulesetId } });
    if (!ruleset) {
      throw new BadRequestException(`Ruleset ${dto.rulesetId} 不存在`);
    }

    const parsed = RulesetDefinitionSchema.safeParse(ruleset.definition);
    if (!parsed.success) {
      throw new BadRequestException(`Ruleset ${ruleset.id} 的 definition 结构非法`);
    }
    const assignments = parsed.data.roles;
    if (assignments.length !== ruleset.playerCount) {
      throw new BadRequestException(
        `Ruleset ${ruleset.id} 的 definition.roles 数量(${assignments.length}) 与 playerCount(${ruleset.playerCount}) 不匹配`,
      );
    }
    if (dto.agentIds.length !== ruleset.playerCount) {
      throw new BadRequestException(
        `agentIds 数量(${dto.agentIds.length}) 与 Ruleset.playerCount(${ruleset.playerCount}) 不匹配`,
      );
    }
    if (new Set(dto.agentIds).size !== dto.agentIds.length) {
      throw new BadRequestException('agentIds 中存在重复 Agent，同一局同一 Agent 不允许占多个座位');
    }

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

    // 随机分配座次与角色
    const shuffledRoles = shuffle(assignments);
    const shuffledAgents = shuffle(agents);

    return this.prisma.game.create({
      data: {
        rulesetId: ruleset.id,
        skillVersion: SKILL_VERSION,
        players: {
          create: shuffledAgents.map((agent, index) => ({
            seatNo: index + 1,
            role: shuffledRoles[index]!.role,
            faction: shuffledRoles[index]!.faction,
            displayName: agent.name,
            modelName: agent.defaultModelName,
            agentId: agent.id,
          })),
        },
      },
      include: {
        players: {
          orderBy: {
            seatNo: 'asc',
          },
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
}

/**
 * Fisher-Yates 洗牌算法
 * 对传入的数组进行随机打乱，返回一个新数组，不修改原数组
 *
 * @param arr - 需要打乱的数组
 * @returns 打乱后的新数组
 */
function shuffle<T>(arr: readonly T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export type { RoleAssignment };

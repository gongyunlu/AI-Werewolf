import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class RulesetsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 列出所有规则集
   *
   * @returns 所有规则集列表
   */
  async listRulesets() {
    return this.prisma.ruleset.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * 根据ID获取规则集详情
   *
   * @param id - 规则集ID
   * @returns 规则集详情
   * @throws {NotFoundException} 当规则集不存在时抛出
   */
  async getRulesetById(id: string) {
    const ruleset = await this.prisma.ruleset.findUnique({
      where: { id },
    });

    if (!ruleset) {
      throw new NotFoundException(`Ruleset ${id} 不存在`);
    }

    return ruleset;
  }
}

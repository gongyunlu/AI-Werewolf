import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { SkillLoaderService } from '../skills/skill-loader.service';

@ApiTags('agent-runtime')
@Controller('agent-runtime')
export class AgentRuntimeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skillLoader: SkillLoaderService,
  ) {}

  @Get('test-catalog/:playerId')
  @ApiOperation({ summary: '【测试】查看玩家的技能目录' })
  async testCatalog(@Param('playerId', new ParseUUIDPipe()) playerId: string) {
    // 查询玩家信息
    const player = await this.prisma.player.findUnique({
      where: { id: playerId },
      include: { game: true },
    });

    if (!player) {
      return { error: 'Player not found' };
    }

    // 构建 LoadContext
    const loadContext = {
      role: player.role,
      faction: player.faction,
      ruleset: player.game.rulesetId,
      scenario: 'night_action',
    };

    // 生成技能目录
    const catalog = this.skillLoader.getCatalogMarkdown(loadContext);

    return {
      playerId,
      playerName: player.displayName,
      role: player.role,
      faction: player.faction,
      catalogLength: catalog.length,
      catalog,
    };
  }
}

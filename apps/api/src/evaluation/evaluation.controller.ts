import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { StatisticsService } from './statistics.service';
import { RankingQueryDto } from './dto/ranking-query.dto';

@ApiTags('evaluation')
@Controller('evaluation')
export class EvaluationController {
  constructor(private readonly statistics: StatisticsService) {}

  @Get('summary')
  @ApiOperation({ summary: '评估总览：总对局数 / 平均天数 / 三阵营胜率' })
  summary() {
    return this.statistics.summary();
  }

  @Get('factions')
  @ApiOperation({ summary: '按 winnerFaction 聚合的胜负分布' })
  factions() {
    return this.statistics.factions();
  }

  @Get('agents/ranking')
  @ApiOperation({ summary: 'Agent 排行（按平均分降序）' })
  agentsRanking(@Query() dto: RankingQueryDto) {
    return this.statistics.agentsRanking(dto.minGames, dto.role);
  }

  @Get('decision-quality')
  @ApiOperation({ summary: '决策质量：整体 + 按动作类型平均分' })
  decisionQuality() {
    return this.statistics.decisionQuality();
  }

  @Get('games/:id')
  @ApiOperation({ summary: '单局评估详情：摘要 + 各玩家表现' })
  gameDetail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.statistics.gameDetail(id);
  }
}

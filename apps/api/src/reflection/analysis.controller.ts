import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { GameAnalysisService } from './game-analysis.service';
import { AnalyzeGameDto } from './dto/analyze-game.dto';

/**
 * 赛后分析端点。
 *
 * 与 EvaluationController 共用 `evaluation` 前缀但分属不同模块：
 * GameAnalysisService 在 ReflectionModule，而 ReflectionModule 已 imports EvaluationModule，
 * 放进 EvaluationController 会形成循环依赖。
 */
@ApiTags('evaluation')
@Controller('evaluation')
export class AnalysisController {
  constructor(private readonly analysis: GameAnalysisService) {}

  @Post('games/:id/analyze')
  @ApiOperation({ summary: '对单局执行赛后分析：决策与发言评分 + 复盘 + 玩家反思' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  analyze(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AnalyzeGameDto) {
    return this.analysis.analyzeGame(id, dto);
  }

  @Get('games/:id/analysis-status')
  @ApiOperation({ summary: '单局赛后分析进度' })
  status(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.analysis.getStatus(id);
  }
}

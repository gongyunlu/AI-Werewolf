import { AdoptScoresDto } from './dto/adopt-scores.dto';
import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { GameAnalysisService } from './game-analysis.service';
import { AnalyzeGameDto } from './dto/analyze-game.dto';
import { ADMIN_TOKEN_HEADER, AdminTokenGuard } from '../common/guards/admin-token.guard';

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

  @Post('games/:id/adopt-scores')
  @UseGuards(AdminTokenGuard)
  @ApiHeader({ name: ADMIN_TOKEN_HEADER, required: true, description: '管理写接口令牌' })
  @ApiOperation({ summary: '明确采用一组完整的 Langfuse 人工或外部评分' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  adoptScores(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: AdoptScoresDto) {
    return this.analysis.adoptScores(id, dto);
  }

  @Post('games/:id/judge')
  @UseGuards(AdminTokenGuard)
  @ApiHeader({ name: ADMIN_TOKEN_HEADER, required: true, description: '管理写接口令牌' })
  @ApiOperation({ summary: '重评单局所有可评估决策' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async rejudgeGame(@Param('id', new ParseUUIDPipe()) id: string) {
    const result = await this.analysis.analyzeGame(id, {
      judge: true,
      reflect: false,
      force: true,
    });
    return { gameId: id, judged: result.judged };
  }

  @Post('rejudge')
  @UseGuards(AdminTokenGuard)
  @ApiHeader({ name: ADMIN_TOKEN_HEADER, required: true, description: '管理写接口令牌' })
  @ApiOperation({ summary: '重评所有已结束对局的决策' })
  @Throttle({ default: { limit: 1, ttl: 60_000 } })
  rejudgeAll() {
    return this.analysis.rejudgeAll();
  }

  @Get('games/:id/analysis-status')
  @ApiOperation({ summary: '单局赛后分析进度' })
  status(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.analysis.getStatus(id);
  }
}

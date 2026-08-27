import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  NotImplementedException,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PinoLogger } from 'nestjs-pino';
import { CreateGameDto } from './dto/create-game.dto';
import { QueryGamesDto } from './dto/query-games.dto';
import { GamesService } from './games.service';
import { GameQueueService } from '../game-queue/game-queue.service';
import { GameLaunchService } from './game-launch.service';

@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(
    private readonly gamesService: GamesService,
    private readonly gameLaunch: GameLaunchService,
    private readonly gameQueue: GameQueueService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(GamesController.name);
  }

  @Get()
  @ApiOperation({ summary: '查询对局列表' })
  queryGames(@Query() dto: QueryGamesDto) {
    return this.gamesService.queryGames(dto);
  }

  @Post()
  @ApiOperation({ summary: '创建对局（对局大厅，未分配角色）' })
  async create(@Body() dto: CreateGameDto) {
    const game = await this.gamesService.createGame(dto);
    this.logger.info({ gameId: game.id, rulesetId: dto.rulesetId }, '对局已创建');
    return game;
  }

  @Post(':id/initialize')
  @ApiOperation({ summary: '初始化对局（随机分配座次与角色）' })
  initialize(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.initializeGame(id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: '开始对局（投递到队列异步执行）' })
  async start(@Param('id', new ParseUUIDPipe()) id: string) {
    const game = await this.gameLaunch.start(id);
    this.logger.info({ gameId: id }, '对局已投递到队列');

    return game;
  }

  @Get(':id')
  @ApiOperation({ summary: '按 id 查询对局详情，含所有玩家' })
  findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.getGameById(id);
  }

  @Get(':id/queue-status')
  @ApiOperation({ summary: '查询对局的队列状态' })
  getQueueStatus(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gameQueue.getJobStatus(id);
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: '取消对局（从队列移除或中断执行）' })
  async cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    const removedFromQueue = await this.gameQueue.cancelJob(id);
    const success = await this.gamesService.cancelGame(id);
    this.logger.info({ gameId: id, removedFromQueue }, '对局已取消');
    return { success, message: '对局已取消', removedFromQueue };
  }

  @Post(':id/pause')
  @ApiOperation({ summary: '暂停对局' })
  async pause(@Param('id', new ParseUUIDPipe()) id: string) {
    throw new NotImplementedException(`对局 ${id} 暂不支持暂停`);
  }

  @Post(':id/resume')
  @ApiOperation({ summary: '继续对局' })
  async resume(@Param('id', new ParseUUIDPipe()) id: string) {
    throw new NotImplementedException(`对局 ${id} 暂不支持恢复执行`);
  }

  // ========== 管理端点 ==========
  // TODO: 管理端点及 cancel/pause/resume 目前无鉴权，任何人可操作任意对局；
  // 对外暴露前需加鉴权（如 API Key guard）保护。

  @Get('admin/pending-recovery')
  @ApiOperation({ summary: '查询所有需要恢复的对局' })
  async getPendingRecoveryGames() {
    return this.gamesService.getPendingRecoveryGames();
  }

  @Post('admin/recover-games')
  @ApiOperation({ summary: '批量恢复所有待恢复状态的对局' })
  async recoverAllGames() {
    throw new NotImplementedException('暂不支持恢复中断的对局');
  }

  @Post('admin/recover-game/:id')
  @ApiOperation({ summary: '恢复单个对局' })
  async recoverSingleGame(@Param('id', new ParseUUIDPipe()) id: string) {
    throw new NotImplementedException(`对局 ${id} 暂不支持恢复执行`);
  }

  @Post('admin/clear-pending-recovery')
  @ApiOperation({ summary: '清理所有待恢复对局（标记为 aborted）' })
  async clearPendingRecovery() {
    const count = await this.gamesService.clearPendingRecovery();
    return {
      message: `已清理 ${count} 个待恢复对局`,
      clearedCount: count,
    };
  }

  @Get('admin/queue-metrics')
  @ApiOperation({ summary: '查询队列统计指标' })
  async getQueueMetrics() {
    return this.gameQueue.getMetrics();
  }
}

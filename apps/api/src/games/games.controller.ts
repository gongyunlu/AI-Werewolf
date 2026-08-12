import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CreateGameDto } from './dto/create-game.dto';
import { GamesService } from './games.service';
import { GameQueueService } from '../game-queue/game-queue.service';
import { GAME_STATUSES } from '@ai-werewolf/shared';

@ApiTags('games')
@Controller('games')
export class GamesController {
  constructor(
    private readonly gamesService: GamesService,
    private readonly gameQueue: GameQueueService,
  ) {}

  @Post()
  @ApiOperation({ summary: '创建对局（对局大厅，未分配角色）' })
  create(@Body() dto: CreateGameDto) {
    return this.gamesService.createGame(dto);
  }

  @Post(':id/initialize')
  @ApiOperation({ summary: '初始化对局（随机分配座次与角色）' })
  initialize(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.gamesService.initializeGame(id);
  }

  @Post(':id/start')
  @ApiOperation({ summary: '开始对局（投递到队列异步执行）' })
  async start(@Param('id', new ParseUUIDPipe()) id: string) {
    // 先投递任务（失败后无副作用），再更新状态
    // 避免状态已更新但任务未投递的情况
    await this.gameQueue.addGameJob(id);
    const game = await this.gamesService.startGame(id);

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
    if (removedFromQueue) {
      this.gamesService['logger'].log(`任务 ${id} 已从队列移除`);
    }
    const success = await this.gamesService.cancelGame(id);
    return { success, message: '对局已取消', removedFromQueue };
  }

  @Post(':id/pause')
  @ApiOperation({ summary: '暂停对局' })
  async pause(@Param('id', new ParseUUIDPipe()) id: string) {
    const removedFromQueue = await this.gameQueue.cancelJob(id);
    if (removedFromQueue) {
      this.gamesService['logger'].log(`任务 ${id} 已从队列移除`);
    }
    await this.gamesService.pauseGame(id);
    return { success: true, message: '对局已暂停', removedFromQueue };
  }

  @Post(':id/resume')
  @ApiOperation({ summary: '继续对局' })
  async resume(@Param('id', new ParseUUIDPipe()) id: string) {
    const game = await this.gamesService.getGameById(id);
    if (game.status !== GAME_STATUSES.PAUSED) {
      throw new BadRequestException(
        `只能继续 ${GAME_STATUSES.PAUSED} 状态的对局，当前状态: ${game.status}`,
      );
    }
    await this.gameQueue.addGameJob(id);
    await this.gamesService.resumeGame(id);

    return { success: true, message: '对局已继续' };
  }

  // ========== 管理端点 ==========

  @Get('admin/pending-recovery')
  @ApiOperation({ summary: '查询所有需要恢复的对局' })
  async getPendingRecoveryGames() {
    return this.gamesService.getPendingRecoveryGames();
  }

  @Post('admin/recover-games')
  @ApiOperation({ summary: '批量恢复所有待恢复状态的对局' })
  async recoverAllGames() {
    const games = await this.gamesService.getPendingRecoveryGames();
    for (const game of games) {
      await this.gamesService.updateGameStatus(game.id, GAME_STATUSES.RUNNING);
      await this.gameQueue.addGameJob(game.id);
    }
    return {
      message: `已恢复 ${games.length} 个对局`,
      games: games.map((g) => ({ id: g.id, startedAt: g.startedAt })),
    };
  }

  @Post('admin/recover-game/:id')
  @ApiOperation({ summary: '恢复单个对局' })
  async recoverSingleGame(@Param('id', new ParseUUIDPipe()) id: string) {
    const game = await this.gamesService.getGameById(id);

    if (game.status !== GAME_STATUSES.PENDING_RECOVERY) {
      throw new BadRequestException(
        `对局状态为 ${game.status}，只能恢复 ${GAME_STATUSES.PENDING_RECOVERY} 状态的对局`,
      );
    }
    await this.gamesService.updateGameStatus(id, GAME_STATUSES.RUNNING);
    await this.gameQueue.addGameJob(id);

    return {
      message: `对局 ${id} 已重新投递到队列`,
      gameId: id,
    };
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

import { Injectable, Logger } from '@nestjs/common';
import { GameQueueService } from '../game-queue/game-queue.service';
import { GamesService } from './games.service';

/** 协调数据库状态转换与游戏任务入队。 */
@Injectable()
export class GameLaunchService {
  private readonly logger = new Logger(GameLaunchService.name);

  constructor(
    private readonly gamesService: GamesService,
    private readonly gameQueue: GameQueueService,
  ) {}

  async start(gameId: string) {
    const game = await this.gamesService.startGame(gameId);

    try {
      await this.gameQueue.addGameJob(gameId);
      return game;
    } catch (enqueueError) {
      let removedFromQueue: boolean;

      try {
        removedFromQueue = await this.gameQueue.cancelJob(gameId);
      } catch (compensationError) {
        this.logger.error(
          {
            gameId,
            enqueueError:
              enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
            compensationError:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          },
          '游戏入队失败且无法确认队列任务状态，保留 running 状态',
        );
        throw enqueueError;
      }

      if (!removedFromQueue) {
        this.logger.error(
          {
            gameId,
            enqueueError:
              enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
          },
          '游戏入队失败且任务未确认移除，保留 running 状态以避免与执行中任务冲突',
        );
        throw enqueueError;
      }

      try {
        await this.gamesService.rollbackFailedStart(gameId);
      } catch (compensationError) {
        this.logger.error(
          {
            gameId,
            enqueueError:
              enqueueError instanceof Error ? enqueueError.message : String(enqueueError),
            compensationError:
              compensationError instanceof Error
                ? compensationError.message
                : String(compensationError),
          },
          '游戏队列任务已移除，但启动状态回滚失败',
        );
      }
      throw enqueueError;
    }
  }
}

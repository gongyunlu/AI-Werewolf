import { Injectable } from '@nestjs/common';
import { GameQueueService } from '../game-queue/game-queue.service';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { GamesService } from './games.service';

@Injectable()
export class GameResumeService {
  constructor(
    private readonly queue: GameQueueService,
    private readonly recovery: GameRecoveryService,
    private readonly games: GamesService,
  ) {}

  async resume(gameId: string) {
    const execution = await this.recovery.prepareResume(gameId);
    const job = await this.queue.getJob(gameId, execution.generation);
    if (!job) {
      await this.queue.addGameJob(gameId, execution.generation);
    } else {
      const state = await job.getState();
      if (state === 'failed' || state === 'completed') {
        const next = await this.recovery.renewDispatch(gameId, execution.generation);
        await this.queue.addGameJob(gameId, next.generation);
      }
    }
    return this.games.getGameById(gameId);
  }
}

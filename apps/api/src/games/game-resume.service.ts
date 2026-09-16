import { Injectable } from '@nestjs/common';
import { GameDispatchService } from '../game-queue/game-dispatch.service';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { GamesService } from './games.service';

@Injectable()
export class GameResumeService {
  constructor(
    private readonly dispatch: GameDispatchService,
    private readonly recovery: GameRecoveryService,
    private readonly games: GamesService,
  ) {}

  async resume(gameId: string) {
    await this.recovery.prepareResume(gameId);
    await this.dispatch.dispatch(gameId);
    return this.games.getGameById(gameId);
  }
}

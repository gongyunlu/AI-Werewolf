import { Injectable } from '@nestjs/common';
import { GameDispatchService } from '../game-queue/game-dispatch.service';
import { GamesService } from './games.service';

@Injectable()
export class GameLaunchService {
  constructor(
    private readonly gamesService: GamesService,
    private readonly dispatch: GameDispatchService,
  ) {}

  async start(gameId: string) {
    const game = await this.gamesService.startGame(gameId);
    await this.dispatch.dispatch(gameId);
    return game;
  }
}

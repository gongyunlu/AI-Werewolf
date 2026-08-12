/**
 * 游戏引擎异常
 */
export class GamePausedException extends Error {
  constructor(public readonly gameId: string) {
    super(`Game ${gameId} has been paused`);
    this.name = 'GamePausedException';
  }
}

/**
 * 游戏取消异常
 *
 * 当游戏被取消时抛出此异常，游戏流程将终止
 */
export class GameAbortedException extends Error {
  constructor(public readonly gameId: string) {
    super(`Game ${gameId} has been aborted`);
    this.name = 'GameAbortedException';
  }
}

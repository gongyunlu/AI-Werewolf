import {
  Controller,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Sse,
} from '@nestjs/common';
import { Observable, concat, from, map } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { GAME_STATUSES } from '@ai-werewolf/shared';
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import type { SceneSnapshot } from '@/sse/sse-event.types';
import { PrismaService } from '@/prisma/prisma.service';

@Controller('games')
export class GameStreamController {
  constructor(
    private readonly broadcaster: SseBroadcasterService,
    private readonly prisma: PrismaService,
  ) {}

  @Sse(':id/stream')
  async stream(
    @Param('id', new ParseUUIDPipe()) gameId: string,
    @Query('lastSequence', new ParseIntPipe({ optional: true })) lastSequence?: number,
  ): Promise<Observable<MessageEvent>> {
    if (this.broadcaster.exists(gameId)) {
      const snapshot: SceneSnapshot[] = [];
      const ready$ = from([
        {
          type: 'connection.ready' as const,
          gameId,
          lastSequence: lastSequence ?? 0,
          snapshot,
        },
      ]);

      const live$ = this.broadcaster.getStream(gameId, lastSequence ?? 0);

      return concat(ready$, live$).pipe(
        map((msg) => ({ data: JSON.stringify(msg) }) as MessageEvent),
      );
    }

    // 广播流已清理：可能是对局已结束（正常），也可能是对局不存在或尚未开始
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
      select: { status: true, winnerFaction: true },
    });

    if (!game) {
      throw new NotFoundException(`游戏 ${gameId} 不存在或尚未开始`);
    }

    const ended = game.status === GAME_STATUSES.FINISHED || game.status === GAME_STATUSES.ABORTED;
    if (!ended) {
      throw new NotFoundException(`游戏 ${gameId} 不存在或尚未开始`);
    }

    // 对局已结束：重放一个 game.finished 终态事件，让前端干净收尾并停止重连，而非反复 404
    return from([
      {
        type: 'game.finished' as const,
        winner: game.winnerFaction ?? 'unknown',
      },
    ]).pipe(map((msg) => ({ data: JSON.stringify(msg) }) as MessageEvent));
  }
}

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
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import type { SceneSnapshot } from '@/sse/sse-event.types';

@Controller('games')
export class GameStreamController {
  constructor(private readonly broadcaster: SseBroadcasterService) {}

  @Sse(':id/stream')
  stream(
    @Param('id', new ParseUUIDPipe()) gameId: string,
    @Query('lastSequence', new ParseIntPipe({ optional: true })) lastSequence?: number,
  ): Observable<MessageEvent> {
    if (!this.broadcaster.exists(gameId)) {
      throw new NotFoundException(`游戏 ${gameId} 不存在或尚未开始`);
    }

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
}

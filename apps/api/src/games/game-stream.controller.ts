import { Controller, Param, ParseUUIDPipe, Sse } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import { EventBusService } from '@/event-bus/event-bus.service';

@Controller('games')
export class GameStreamController {
  constructor(
    private readonly broadcaster: SseBroadcasterService,
    private readonly eventBus: EventBusService,
  ) {}

  @Sse(':id/stream')
  async stream(
    @Param('id', new ParseUUIDPipe()) gameId: string,
  ): Promise<Observable<MessageEvent>> {
    await this.eventBus.assertExists(gameId);
    return this.broadcaster
      .getRecoveryStream(gameId, () => this.eventBus.loadSnapshot(gameId))
      .pipe(map((msg) => ({ data: JSON.stringify(msg) }) as MessageEvent));
  }
}

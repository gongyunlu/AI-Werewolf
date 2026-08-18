import { Module } from '@nestjs/common';
import { SseBroadcasterService } from './sse-broadcaster.service';

@Module({
  providers: [SseBroadcasterService],
  exports: [SseBroadcasterService],
})
export class SseModule {}

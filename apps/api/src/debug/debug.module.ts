import { Module } from '@nestjs/common';
import { DebugService } from './debug.service';
import { DebugController } from './debug.controller';
import { TestSseController } from './test-sse.controller';

@Module({
  controllers: [DebugController, TestSseController],
  providers: [DebugService],
})
export class DebugModule {}

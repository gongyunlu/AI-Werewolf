import { Module } from '@nestjs/common';
import { DebugService } from './debug.service';
import { DebugController } from './debug.controller';
import { TestSseController } from './test-sse.controller';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';

@Module({
  imports: [AgentRuntimeModule],
  controllers: [DebugController, TestSseController],
  providers: [DebugService],
})
export class DebugModule {}

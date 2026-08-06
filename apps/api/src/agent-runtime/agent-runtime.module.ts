import { Module } from '@nestjs/common';
import { AgentToolsFactory } from './tools/tools.factory';
import { AgentRuntimeService } from './agent-runtime.service';
import { MemoryModule } from '../memory/memory.module';

@Module({
  imports: [MemoryModule],
  providers: [AgentToolsFactory, AgentRuntimeService],
  exports: [AgentToolsFactory, AgentRuntimeService],
})
export class AgentRuntimeModule {}

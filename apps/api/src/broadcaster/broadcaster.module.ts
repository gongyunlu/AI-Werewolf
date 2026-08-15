import { Module } from '@nestjs/common';
import { BroadcasterService } from './broadcaster.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentRuntimeModule } from '../agent-runtime/agent-runtime.module';

@Module({
  imports: [PrismaModule, AgentRuntimeModule],
  providers: [BroadcasterService],
  exports: [BroadcasterService],
})
export class BroadcasterModule {}

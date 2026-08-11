import { Module } from '@nestjs/common';
import { GameEngine } from './game-engine';
import { AgentRuntimeModule } from '@/agent-runtime/agent-runtime.module';
import { PrismaModule } from '@/prisma/prisma.module';
import { EventWriterService } from '../events/event-writer.service';

/**
 * 游戏引擎模块
 */
@Module({
  imports: [AgentRuntimeModule, PrismaModule],
  providers: [GameEngine, EventWriterService],
  exports: [GameEngine, EventWriterService],
})
export class GameEngineModule {}

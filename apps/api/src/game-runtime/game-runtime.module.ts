import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EventsModule } from '../game-engine/events/events.module';
import { GameExecutorModule } from '../game-executor/game-executor.module';
import { GameRuntimeService } from './game-runtime.service';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';

/** 图执行的落地模块：检查点存储与工作流都在这里装配，不接入生产执行器。 */
@Module({
  imports: [PrismaModule, EventsModule, GameExecutorModule, GameRecoveryModule],
  providers: [GameRuntimeService],
  exports: [GameRuntimeService],
})
export class GameRuntimeModule {}

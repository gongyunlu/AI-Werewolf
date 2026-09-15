import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { GameRecoveryService } from './game-recovery.service';
import { SseModule } from '../sse/sse.module';

@Module({
  imports: [PrismaModule, SseModule],
  providers: [GameRecoveryService],
  exports: [GameRecoveryService],
})
export class GameRecoveryModule {}

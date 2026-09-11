import { PrismaModule } from '@/prisma/prisma.module';
import { RedisModule } from '@/redis/redis.module';
import { Module } from '@nestjs/common';
import { GameRecoveryModule } from '@/game-recovery/game-recovery.module';
import { EventWriterService } from './event-writer.service';

@Module({
  imports: [PrismaModule, RedisModule, GameRecoveryModule],
  providers: [EventWriterService],
  exports: [EventWriterService],
})
export class EventsModule {}

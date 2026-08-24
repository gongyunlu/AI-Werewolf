import { PrismaModule } from '@/prisma/prisma.module';
import { RedisModule } from '@/redis/redis.module';
import { Module } from '@nestjs/common';
import { EventWriterService } from './event-writer.service';

@Module({
  imports: [PrismaModule, RedisModule],
  providers: [EventWriterService],
  exports: [EventWriterService],
})
export class EventsModule {}

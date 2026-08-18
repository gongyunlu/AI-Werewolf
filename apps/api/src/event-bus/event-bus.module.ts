import { Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SseModule } from '../sse/sse.module';

@Module({
  imports: [PrismaModule, SseModule],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventBusModule {}

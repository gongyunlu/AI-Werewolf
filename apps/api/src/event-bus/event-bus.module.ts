import { Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BroadcasterModule } from '../broadcaster/broadcaster.module';

@Module({
  imports: [PrismaModule, BroadcasterModule],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventBusModule {}

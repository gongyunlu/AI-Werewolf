import { Module } from '@nestjs/common';
import { EventBusService } from './event-bus.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [EventBusService],
  exports: [EventBusService],
})
export class EventBusModule {}

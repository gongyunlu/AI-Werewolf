import { Module } from '@nestjs/common';
import { AgentsController } from './agents.controller';
import { AgentsService } from './agents.service';
import { AdminTokenGuard } from '../common/guards/admin-token.guard';

@Module({
  controllers: [AgentsController],
  providers: [AgentsService, AdminTokenGuard],
})
export class AgentsModule {}

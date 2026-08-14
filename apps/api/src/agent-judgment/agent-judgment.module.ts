import { Module } from '@nestjs/common';
import { AgentJudgmentService } from './agent-judgment.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  providers: [AgentJudgmentService],
  exports: [AgentJudgmentService],
})
export class AgentJudgmentModule {}

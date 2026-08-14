import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SpeechSummarizerService } from './speech-summarizer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentJudgmentModule } from '../agent-judgment/agent-judgment.module';

@Module({
  imports: [ConfigModule, PrismaModule, AgentJudgmentModule],
  providers: [SpeechSummarizerService],
  exports: [SpeechSummarizerService],
})
export class SpeechSummarizerModule {}

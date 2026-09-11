import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SpeechSummarizerService } from './speech-summarizer.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentJudgmentModule } from '../agent-judgment/agent-judgment.module';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';

@Module({
  imports: [ConfigModule, PrismaModule, AgentJudgmentModule, GameRecoveryModule],
  providers: [SpeechSummarizerService],
  exports: [SpeechSummarizerService],
})
export class SpeechSummarizerModule {}

import { ModelCallModule } from '../llm/model-call.module';
import { PlayerTurnModule } from '../player-turn/player-turn.module';
import { Module } from '@nestjs/common';
import { GameRecoveryModule } from '../game-recovery/game-recovery.module';
import { ConfigModule } from '@nestjs/config';
import { AgentRuntimeService } from './agent-runtime.service';
import { AbortControllerManager } from './abort-controller.manager';
import { MemoryModule } from '../memory/memory.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SkillLoaderModule } from '../skills/skill-loader.module';
import { SpeechSummarizerModule } from '../speech-summarizer/speech-summarizer.module';
import { ObservabilityModule } from '../observability/observability.module';
import { ChatHistoryService, chatHistoryPoolProvider } from './chat-history.service';

@Module({
  imports: [
    ModelCallModule,
    PlayerTurnModule,
    GameRecoveryModule,
    ConfigModule,
    PrismaModule,
    MemoryModule,
    KnowledgeModule,
    SkillLoaderModule,
    SpeechSummarizerModule,
    ObservabilityModule,
  ],
  providers: [
    chatHistoryPoolProvider,
    ChatHistoryService,
    AgentRuntimeService,
    AbortControllerManager,
  ],
  exports: [AgentRuntimeService, AbortControllerManager],
})
export class AgentRuntimeModule {}

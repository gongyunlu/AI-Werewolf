import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentRuntimeService } from '../agent-runtime/agent-runtime.service';
import type { Env } from '../config/env.validation';
import { EventBusService } from '../event-bus/event-bus.service';
import { GameEngine } from '../game-engine/core/game-engine';
import { EventWriterService } from '../game-engine/events/event-writer.service';
import { NodeRegistrar } from '../game-engine/nodes/node-registrar.service';
import { GameRecoveryService } from '../game-recovery/game-recovery.service';
import { LangfuseService } from '../observability/langfuse.service';
import { PromptService } from '../observability/prompt.service';
import { PrismaService } from '../prisma/prisma.service';
import { SpeechSummarizerService } from '../speech-summarizer/speech-summarizer.service';
import { SseBroadcasterService } from '../sse/sse-broadcaster.service';

/** 共享服务由 Nest 装配，引擎的信号、节点序号和暂停状态按局创建。 */
@Injectable()
export class GameEngineFactory {
  constructor(
    private readonly agentRuntime: AgentRuntimeService,
    private readonly prisma: PrismaService,
    private readonly eventWriter: EventWriterService,
    private readonly broadcaster: SseBroadcasterService,
    private readonly nodeRegistrar: NodeRegistrar,
    private readonly eventBus: EventBusService,
    private readonly configService: ConfigService<Env, true>,
    private readonly speechSummarizer: SpeechSummarizerService,
    private readonly langfuse: LangfuseService,
    private readonly promptService: PromptService,
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {}

  create(): GameEngine {
    return new GameEngine(
      this.agentRuntime,
      this.prisma,
      this.eventWriter,
      this.broadcaster,
      this.nodeRegistrar.registry,
      this.eventBus,
      this.configService,
      this.speechSummarizer,
      this.langfuse,
      this.promptService,
      this.recovery,
    );
  }
}

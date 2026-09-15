import type { ConfigService } from '@nestjs/config';
import type { GameGraphState } from '../core/types';
import type { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import type { PrismaService } from '@/prisma/prisma.service';
import type { EventWriterService } from '../events/event-writer.service';
import type { GamePreset } from '../presets/game-presets';
import type { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import type { EventBusService } from '@/event-bus/event-bus.service';
import type { LangfuseService } from '@/observability/langfuse.service';
import type { PromptService } from '@/observability/prompt.service';
import type { Env } from '@/config/env.validation';
import type { VoteTurnPort } from '../ports/vote-turn.port';
import type { GameRecoveryService } from '@/game-recovery/game-recovery.service';
import { randomUUID } from 'node:crypto';
import { submissionKey } from '../events/submission-protocol';

/**
 * 游戏节点函数类型
 */
export type GameNode = (state: GameGraphState) => Promise<Partial<GameGraphState>>;

/**
 * 节点上下文（依赖注入）
 */
export interface NodeContext {
  agentRuntime: AgentRuntimeService;
  /** 由 composition root 绑定的玩家回合端口；目前只有普通投票走它。 */
  voteTurn: VoteTurnPort;
  prisma: PrismaService;
  eventWriter: EventWriterService;
  configService: ConfigService<Env, true>;
  signal?: AbortSignal; // 用于中断游戏执行
  /** 固定配置的实验局：模型调用失败即判实验无效，不允许替代行动。 */
  strictExperiment?: boolean;
  recovery?: GameRecoveryService;
  preset?: GamePreset; // 板子配置（用于 NIGHT/DAY 节点访问 pipeline）
  pauseCheckWrapper?: (node: GameNode) => GameNode; // 暂停检查包装器（由 GameEngine 注入到每局上下文）
  broadcaster?: Pick<SseBroadcasterService, 'emit'>;
  eventBus?: EventBusService;
  langfuse: LangfuseService;
  promptService: PromptService;
}

/**
 * 节点工厂：根据上下文创建节点
 */
export type NodeFactory = (context: NodeContext) => GameNode;

export function saveNodeValue<T>(
  context: NodeContext,
  key: string,
  produce: () => T | Promise<T>,
): Promise<T> {
  return context.recovery
    ? context.recovery.value(key, async () => produce())
    : Promise.resolve(produce());
}

/** 逻辑场景随原节点路径稳定，生成尝试只用于交付，不参与领域幂等。 */
export function createSceneIdentity(state: GameGraphState, actorId: string, ordinal = 0) {
  return {
    sceneId: submissionKey(state, 'scene/speech', actorId, ordinal),
    attemptId: randomUUID(),
  };
}

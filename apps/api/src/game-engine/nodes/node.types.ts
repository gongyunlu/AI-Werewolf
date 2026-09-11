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
import type { GameFailurePolicy } from '../core/game-failure-policy';
import type { GameRecoveryService } from '@/game-recovery/game-recovery.service';
import type { Prisma } from '@/generated/prisma/client';

/**
 * 游戏节点函数类型
 */
export type GameNode = (state: GameGraphState) => Promise<Partial<GameGraphState>>;

/**
 * 节点上下文（依赖注入）
 */
export interface NodeContext {
  agentRuntime: AgentRuntimeService;
  prisma: PrismaService;
  eventWriter: EventWriterService;
  configService: ConfigService<Env, true>;
  signal?: AbortSignal; // 用于中断游戏执行
  failurePolicy?: GameFailurePolicy;
  recovery?: GameRecoveryService;
  preset?: GamePreset; // 板子配置（用于 NIGHT/DAY 节点访问 pipeline）
  pauseCheckWrapper?: (node: GameNode) => GameNode; // 暂停检查包装器（由 GameEngine 注入到每局上下文）
  broadcaster?: SseBroadcasterService;
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

export async function updatePlayerState(
  context: NodeContext,
  playerId: string,
  data: Prisma.PlayerUpdateInput,
): Promise<void> {
  const update = (db: Prisma.TransactionClient) =>
    db.player.update({ where: { id: playerId }, data });
  if (context.recovery) await context.recovery.effect(`player/${playerId}`, update);
  else await update(context.prisma);
}

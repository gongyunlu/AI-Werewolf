import type { ConfigService } from '@nestjs/config';
import type { GameGraphState } from '../core/types';
import type { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import type { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import type { PrismaService } from '@/prisma/prisma.service';
import type { EventWriterService } from '../events/event-writer.service';
import type { GamePreset } from '../presets/game-presets';
import type { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import type { EventBusService } from '@/event-bus/event-bus.service';
import type { Env } from '@/config/env.validation';

/**
 * 游戏节点函数类型
 */
export type GameNode = (state: GameGraphState) => Promise<Partial<GameGraphState>>;

/**
 * 节点上下文（依赖注入）
 */
export interface NodeContext {
  agentRuntime: AgentRuntimeService;
  toolsFactory: AgentToolsFactory;
  prisma: PrismaService;
  eventWriter: EventWriterService;
  configService: ConfigService<Env, true>;
  signal?: AbortSignal; // 用于中断游戏执行
  preset?: GamePreset; // 板子配置（用于 NIGHT/DAY 节点访问 pipeline）
  pauseCheckWrapper?: (node: GameNode) => GameNode; // 暂停检查包装器（由 GameEngine 注入到每局上下文）
  broadcaster?: SseBroadcasterService;
  eventBus?: EventBusService;
}

/**
 * 节点工厂：根据上下文创建节点
 */
export type NodeFactory = (context: NodeContext) => GameNode;

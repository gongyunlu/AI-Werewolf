import type { GameGraphState } from '../core/types';
import type { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import type { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import type { PrismaService } from '@/prisma/prisma.service';
import type { EventWriterService } from '../events/event-writer.service';

/**
 * 游戏节点函数类型
 *
 * 每个节点：
 * - 输入：GameGraphState
 * - 输出：Partial<GameGraphState>（状态更新）
 * - 职责单一，可独立测试
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
}

/**
 * 节点工厂：根据上下文创建节点
 */
export type NodeFactory = (context: NodeContext) => GameNode;

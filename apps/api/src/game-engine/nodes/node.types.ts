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
import type { VoteTurnPort } from '../ports/vote-turn.port';
import type { GameRecoveryService } from '@/game-recovery/game-recovery.service';

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

/**
 * 发言失败或中断时，给已经打开的卡片补一条收尾声明。
 *
 * 思考与正文是边生成边外发的，已经流出去的 token 收不回来，只能追加一句说明，
 * 否则观战者会把半截内容当成一轮正常发言。声明只走实时广播，不进事件内容：
 * 这一轮没有提交任何发言，落库记录里也不需要它。
 */
export function appendSceneNotice(context: NodeContext, gameId: string, sceneId: string): void {
  context.broadcaster?.emit(gameId, {
    type: 'scene.append',
    sceneId,
    token: '（本轮发言未完成，没有产出正文）',
    contentType: 'content',
  });
}

import type { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import type { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import type { PrismaService } from '@/prisma/prisma.service';
import type { EventWriterService } from '../events/event-writer.service';
import type { SseBroadcasterService } from '@/sse/sse-broadcaster.service';
import type { EventBusService } from '@/event-bus/event-bus.service';
import type { WerewolfKillNode } from '../nodes/night/werewolf-kill.node';
import type { WitchAntidoteNode } from '../nodes/night/witch-antidote.node';
import type { WitchPoisonNode } from '../nodes/night/witch-poison.node';
import type { SeerCheckNode } from '../nodes/night/seer-check.node';
import type { SpeechNode } from '../nodes/day/speech.node';
import type { VoteNode } from '../nodes/day/vote.node';
import type { LastWordsNode } from '../nodes/day/last-words.node';
import type { ExileLastWordsNode } from '../nodes/day/exile-last-words.node';
import type { SheriffDecideOrderNode } from '../nodes/day/sheriff-decide-order.node';
import type { PkSpeechNode } from '../nodes/day/pk-speech.node';
import type { PkVoteNode } from '../nodes/day/pk-vote.node';
import type { NodeRegistrar } from '../nodes/node-registrar.service';

/**
 * 创建 Mock 节点工厂
 */
const createMockNode = () => ({
  create: jest.fn().mockReturnValue(() => async () => ({})),
});

/**
 * 测试辅助函数：创建 Mock 依赖
 *
 * Mock AgentRuntime 返回 { success: false }，触发节点的降级策略（随机决策），
 * 这样测试可以验证主图流程而不依赖真实 LLM。
 */
export function createMockDependencies() {
  const mockAgentRuntime = {
    run: jest.fn().mockResolvedValue({ success: false }), // 触发降级策略
  } as unknown as AgentRuntimeService;

  const mockToolsFactory = {
    buildNightActionTools: jest.fn().mockReturnValue([]),
    buildSpeechTools: jest.fn().mockReturnValue([]),
    buildVoteTools: jest.fn().mockReturnValue([]),
  } as unknown as AgentToolsFactory;

  const mockPrisma = {
    player: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    ruleset: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'standard6p',
        name: '标准6人局',
        definition: {
          speechRules: {
            useTimeRule: true,
            timeRuleConfig: {
              oddMinuteDirection: 'clockwise',
              evenMinuteDirection: 'counterclockwise',
            },
            useDeathPosition: true,
            deathPositionOffset: 'next',
          },
        },
      }),
    },
  } as unknown as PrismaService;

  const mockEventWriter = {
    writeWolfKillEvent: jest.fn().mockResolvedValue(undefined),
    writeSeerCheckEvent: jest.fn().mockResolvedValue(undefined),
    writeWitchAntidoteEvent: jest.fn().mockResolvedValue(undefined),
    writeWitchPoisonEvent: jest.fn().mockResolvedValue(undefined),
    writeDeathAnnouncementEvent: jest.fn().mockResolvedValue(undefined),
    writePeacefulNightEvent: jest.fn().mockResolvedValue(undefined),
    writePlayerSpeechEvent: jest.fn().mockResolvedValue(undefined),
    writeWolfDiscussionEvent: jest.fn().mockResolvedValue(undefined),
    writePlayerVoteEvent: jest.fn().mockResolvedValue(undefined),
    writePlayerExiledEvent: jest.fn().mockResolvedValue(undefined),
    writeIdiotRevealEvent: jest.fn().mockResolvedValue(undefined),
    writeSheriffDecideOrderEvent: jest.fn().mockResolvedValue(undefined),
    writeSpeechOrderDeterminedEvent: jest.fn().mockResolvedValue(undefined),
    writeGameStartEvent: jest.fn().mockResolvedValue(undefined),
    writeGameEndEvent: jest.fn().mockResolvedValue(undefined),
    writeJudgeEvent: jest.fn().mockResolvedValue(undefined),
    writeNightPromptEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as EventWriterService;

  const mockBroadcaster = {
    emit: jest.fn(),
    getOrCreate: jest.fn(),
    getStream: jest.fn(),
    complete: jest.fn(),
    exists: jest.fn(),
  } as unknown as SseBroadcasterService;

  const mockEventBus = {
    publish: jest.fn(),
  } as unknown as EventBusService;

  const mockWerewolfKillNode = createMockNode() as unknown as WerewolfKillNode;
  const mockWitchAntidoteNode = createMockNode() as unknown as WitchAntidoteNode;
  const mockWitchPoisonNode = createMockNode() as unknown as WitchPoisonNode;
  const mockSeerCheckNode = createMockNode() as unknown as SeerCheckNode;
  const mockSpeechNode = createMockNode() as unknown as SpeechNode;
  const mockVoteNode = createMockNode() as unknown as VoteNode;
  const mockLastWordsNode = createMockNode() as unknown as LastWordsNode;
  const mockExileLastWordsNode = createMockNode() as unknown as ExileLastWordsNode;
  const mockSheriffDecideOrderNode = createMockNode() as unknown as SheriffDecideOrderNode;
  const mockPkSpeechNode = createMockNode() as unknown as PkSpeechNode;
  const mockPkVoteNode = createMockNode() as unknown as PkVoteNode;

  const mockNodeRegistrar = {
    registerAll: jest.fn(),
  } as unknown as NodeRegistrar;

  return {
    mockAgentRuntime,
    mockToolsFactory,
    mockPrisma,
    mockEventWriter,
    mockBroadcaster,
    mockEventBus,
    mockWerewolfKillNode,
    mockWitchAntidoteNode,
    mockWitchPoisonNode,
    mockSeerCheckNode,
    mockSpeechNode,
    mockVoteNode,
    mockLastWordsNode,
    mockExileLastWordsNode,
    mockSheriffDecideOrderNode,
    mockPkSpeechNode,
    mockPkVoteNode,
    mockNodeRegistrar,
  };
}

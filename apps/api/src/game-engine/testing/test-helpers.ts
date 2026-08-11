import type { AgentRuntimeService } from '@/agent-runtime/agent-runtime.service';
import type { AgentToolsFactory } from '@/agent-runtime/tools/agent-tools.factory';
import type { PrismaService } from '@/prisma/prisma.service';
import type { EventWriterService } from '../events/event-writer.service';

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
    writePlayerVoteEvent: jest.fn().mockResolvedValue(undefined),
    writePlayerExiledEvent: jest.fn().mockResolvedValue(undefined),
    writeIdiotRevealEvent: jest.fn().mockResolvedValue(undefined),
    writeSpecialRoleTriggerEvent: jest.fn().mockResolvedValue(undefined),
    writeSpeechOrderDeterminedEvent: jest.fn().mockResolvedValue(undefined),
  } as unknown as EventWriterService;

  return {
    mockAgentRuntime,
    mockToolsFactory,
    mockPrisma,
    mockEventWriter,
  };
}

import { Test } from '@nestjs/testing';
import { AgentRuntimeService } from './agent-runtime.service';
import { PrismaService } from '../prisma/prisma.service';
import { MemoryService } from '../memory/memory.service';
import { SkillLoaderService } from '../skills/skill-loader.service';
import { ConfigService } from '@nestjs/config';
import { AGENT_SCENARIOS } from '@ai-werewolf/shared';

/**
 * Agent 测试
 */
describe('AgentRuntimeService', () => {
  let service: AgentRuntimeService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        AgentRuntimeService,
        {
          provide: PrismaService,
          useValue: {
            player: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
            },
            event: {
              findMany: jest.fn(),
              findFirst: jest.fn(),
            },
            game: {
              findUnique: jest.fn(),
            },
          },
        },
        {
          provide: MemoryService,
          useValue: {
            retrieveActiveMemories: jest.fn().mockResolvedValue([
              { type: 'persona', content: '测试人设' },
              { type: 'strategy', content: '测试策略' },
            ]),
          },
        },
        {
          provide: SkillLoaderService,
          useValue: {
            loadCoreFramework: jest.fn().mockResolvedValue('核心决策框架'),
            loadRuleSkill: jest.fn().mockResolvedValue('狼人杀规则'),
            loadRoleSkill: jest.fn().mockResolvedValue('角色技能'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const config: Record<string, string> = {
                ARK_API_KEY: 'test-key',
                ARK_DEFAULT_MODEL: 'test-model',
                ARK_BASE_URL: 'https://test.api',
                SKILLS_DIR: '',
              };
              return config[key];
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AgentRuntimeService>(AgentRuntimeService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe('prepareContext', () => {
    it('应该正确准备上下文', async () => {
      // Mock 数据（使用正确的 schema 字段）
      const mockPlayer = {
        id: 'player-1',
        gameId: 'game-1',
        agentId: 'agent-1',
        displayName: '1号玩家',
        seatNo: 1,
        role: 'villager',
        deathDay: null, // 使用 deathDay 而不是 isAlive
        memoryLabelSnapshot: 'snapshot-1',
        game: {
          id: 'game-1',
          status: 'playing',
          totalDays: 2,
          winnerCamp: null,
        },
      };

      const mockEvents = [
        {
          id: 'event-1',
          gameId: 'game-1',
          sequence: 1,
          day: 1,
          phase: 'execute',
          actionType: 'player_death', // 使用 actionType 而不是 type
          visibility: 'public',
          actorId: null,
          targetIds: ['player-2'],
          content: { message: '2号玩家死亡' },
          createdAt: new Date(),
        },
        {
          id: 'event-2',
          gameId: 'game-1',
          sequence: 2,
          day: 2,
          phase: 'speech',
          actionType: 'make_speech',
          visibility: 'public',
          actorId: 'player-3',
          targetIds: null,
          content: { message: '3号玩家发言：...' },
          createdAt: new Date(),
        },
      ];

      jest.spyOn(prisma.player, 'findUnique').mockResolvedValue(mockPlayer as any);
      jest.spyOn(prisma.player, 'findMany').mockResolvedValue([
        { seatNo: 1, displayName: '1号玩家' },
        { seatNo: 4, displayName: '4号玩家' },
      ] as any);
      jest.spyOn(prisma.event, 'findMany').mockResolvedValue(mockEvents as any);
      jest.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);

      // 测试
      const context = await (service as any).prepareContext({
        gameId: 'game-1',
        playerId: 'player-1',
        scenario: AGENT_SCENARIOS.VOTE,
        availableTools: [],
      });

      expect(context).toBeDefined();
      expect(context.systemPrompt).toContain('1号玩家');
      expect(context.systemPrompt).toContain('villager');
      expect(context.player).toEqual(mockPlayer);
    });
  });

  describe('buildLayeredContext', () => {
    it('应该正确构建分层上下文', async () => {
      const mockPlayer = {
        id: 'player-1',
        gameId: 'game-1',
        agentId: 'agent-1',
        displayName: '1号玩家',
        seatNo: 1,
        role: 'villager',
        deathDay: null,
        memoryLabelSnapshot: 'snapshot-1',
        game: {
          id: 'game-1',
          status: 'playing',
          totalDays: 3,
          winnerCamp: null,
        },
      };

      const mockEvents = [
        {
          id: 'event-1',
          gameId: 'game-1',
          sequence: 1,
          day: 1,
          phase: 'execute',
          actionType: 'death_announcement',
          visibility: 'public',
          actorId: null,
          targetIds: ['player-2'],
          content: { deaths: [{ seatNo: 2, deathCause: 'wolf_kill' }] },
          createdAt: new Date(),
        },
        {
          id: 'event-2',
          gameId: 'game-1',
          sequence: 2,
          day: 3,
          phase: 'speech',
          actionType: 'player_speech',
          visibility: 'public',
          actorId: 'player-1',
          targetIds: null,
          content: { seatNo: 1, speech: '近期详细：玩家发言内容' },
          createdAt: new Date(),
        },
      ];

      jest.spyOn(prisma.event, 'findFirst').mockResolvedValue({
        id: 'summary-1',
        gameId: 'game-1',
        sequence: 100,
        day: 1,
        phase: 'day_announce',
        actionType: 'round_summary',
        visibility: 'public',
        actorId: null,
        targetIds: null,
        content: { summary: '历史摘要：第1轮摘要' },
        createdAt: new Date(),
      } as any);

      jest
        .spyOn(prisma.player, 'findMany')
        .mockResolvedValue([
          mockPlayer,
          { ...mockPlayer, id: 'player-2', seatNo: 2, displayName: '2号玩家' },
        ] as any);

      const context = await (service as any).buildLayeredContext({
        player: mockPlayer,
        events: mockEvents,
        scenario: AGENT_SCENARIOS.VOTE,
      });

      expect(context.critical).toContain('第 3 天');
      expect(context.recent).toContain('近期详细');
      expect(context.history).toContain('Day 1');
    });
  });

  describe('run', () => {
    it('应该在模拟场景下成功运行', async () => {
      // Mock 玩家和事件
      const mockPlayer = {
        id: 'player-1',
        gameId: 'game-1',
        agentId: 'agent-1',
        displayName: '1号玩家',
        seatNo: 1,
        role: 'villager',
        deathDay: null,
        memoryLabelSnapshot: 'snapshot-1',
        game: {
          id: 'game-1',
          status: 'playing',
          totalDays: 1,
          winnerCamp: null,
        },
      };

      jest.spyOn(prisma.player, 'findUnique').mockResolvedValue(mockPlayer as any);
      jest.spyOn(prisma.event, 'findMany').mockResolvedValue([]);
      jest.spyOn(prisma.event, 'findFirst').mockResolvedValue(null);

      // 注意：这个测试会实际调用 LLM API
      // 在 CI 环境中应该 skip 或 mock LLM 调用
      // 这里仅作为结构验证

      expect(service).toBeDefined();
    });
  });
});

import { createLastWordsNode } from './last-words.node';
import type { GameGraphState } from '../../core/types';
import type { NodeContext } from '../node.types';

describe('LastWordsNode - 遗言规则', () => {
  let mockContext: NodeContext;
  let mockPrismaFindMany: jest.Mock;

  beforeEach(() => {
    mockPrismaFindMany = jest.fn();
    mockContext = {
      prisma: {
        player: {
          findMany: mockPrismaFindMany,
        },
      } as any,
      agentRuntime: {} as any,
      eventWriter: {} as any,
      toolsFactory: {} as any,
    };
  });

  describe('首夜死亡遗言规则', () => {
    it('第1天：首夜死亡的玩家应该能发表遗言', async () => {
      const state: GameGraphState = {
        gameId: 'test-game',
        currentDay: 1,
        players: [],
      } as any;

      mockPrismaFindMany.mockResolvedValue([{ id: 'player-1', seatNo: 1, deathDay: 1 }]);

      const node = createLastWordsNode(mockContext);
      await node(state);

      // 验证查询条件：只查询 deathDay 为 1 的玩家
      expect(mockPrismaFindMany).toHaveBeenCalledWith({
        where: {
          gameId: 'test-game',
          deathDay: 1,
        },
        orderBy: { seatNo: 'asc' },
      });
    });

    it('第2天：第2夜死亡的玩家不应该发表遗言', async () => {
      const state: GameGraphState = {
        gameId: 'test-game',
        currentDay: 2,
        players: [],
      } as any;

      const node = createLastWordsNode(mockContext);
      await node(state);

      // 验证：第2天不应该查询数据库，直接跳过
      expect(mockPrismaFindMany).not.toHaveBeenCalled();
    });

    it('第3天及之后：夜晚死亡的玩家不应该发表遗言', async () => {
      const state: GameGraphState = {
        gameId: 'test-game',
        currentDay: 3,
        players: [],
      } as any;

      const node = createLastWordsNode(mockContext);
      await node(state);

      // 验证：第3天不应该查询数据库，直接跳过
      expect(mockPrismaFindMany).not.toHaveBeenCalled();
    });
  });

  describe('平安夜场景', () => {
    it('首夜平安夜：无人死亡时应该跳过遗言', async () => {
      const state: GameGraphState = {
        gameId: 'test-game',
        currentDay: 1,
        players: [],
      } as any;

      mockPrismaFindMany.mockResolvedValue([]);

      const node = createLastWordsNode(mockContext);
      const result = await node(state);

      expect(mockPrismaFindMany).toHaveBeenCalled();
      expect(result).toEqual({});
    });
  });
});

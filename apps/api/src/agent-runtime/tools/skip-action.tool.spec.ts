import { createSkipActionTool } from './skip-action.tool';

describe('skip-action.tool', () => {
  describe('createSkipActionTool', () => {
    it('应该成功返回空过意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createSkipActionTool(ctx);

      const result = await tool.invoke({ reason: '今晚保留解药' });

      expect(result).toEqual({
        action: 'skip',
        actorId: 'player-1',
        reason: '今晚保留解药',
      });
    });

    it('应该允许不提供理由', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createSkipActionTool(ctx);

      const result = await tool.invoke({});

      expect(result).toEqual({
        action: 'skip',
        actorId: 'player-1',
      });
    });

    it('应该包含 actorId', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'witch-1' };
      const tool = createSkipActionTool(ctx);

      const result = await tool.invoke({ reason: '不确定' });

      expect(result.actorId).toBe('witch-1');
    });
  });
});

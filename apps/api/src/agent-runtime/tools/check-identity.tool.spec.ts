import { createCheckIdentityTool } from './check-identity.tool';

describe('check-identity.tool', () => {
  describe('createCheckIdentityTool', () => {
    it('应该成功返回查验意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'seer-1' };
      const tool = createCheckIdentityTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 5 });

      expect(result).toEqual({
        action: 'check_identity',
        actorId: 'seer-1',
        targetSeatNo: 5,
      });
    });

    it('应该允许查验任何座位号', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'seer-1' };
      const tool = createCheckIdentityTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 1 });

      expect(result).toEqual({
        action: 'check_identity',
        actorId: 'seer-1',
        targetSeatNo: 1,
      });
    });
  });
});

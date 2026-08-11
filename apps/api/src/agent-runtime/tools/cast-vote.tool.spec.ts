import { createCastVoteTool } from './cast-vote.tool';

describe('cast-vote.tool', () => {
  describe('createCastVoteTool', () => {
    it('应该成功返回投票意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createCastVoteTool(ctx);

      const result = await tool.invoke({
        targetSeatNo: 5,
      });

      expect(result).toEqual({
        action: 'cast_vote',
        actorId: 'player-1',
        targetSeatNo: 5,
      });
    });

    it('应该允许投任何座位号（包括自己）', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createCastVoteTool(ctx);

      const result = await tool.invoke({
        targetSeatNo: 1,
      });

      expect(result).toEqual({
        action: 'cast_vote',
        actorId: 'player-1',
        targetSeatNo: 1,
      });
    });
  });
});

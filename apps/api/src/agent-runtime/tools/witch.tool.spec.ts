import { createUseAntidoteTool, createUsePoisonTool } from './witch.tool';

describe('witch.tool', () => {
  describe('createUseAntidoteTool', () => {
    it('应该成功返回使用解药的意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'witch-1' };
      const tool = createUseAntidoteTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 5 });

      expect(result).toEqual({
        action: 'antidote',
        actorId: 'witch-1',
        targetSeatNo: 5,
      });
    });

    it('应该允许救任何座位号', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'witch-1' };
      const tool = createUseAntidoteTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 7 });

      expect(result).toEqual({
        action: 'antidote',
        actorId: 'witch-1',
        targetSeatNo: 7,
      });
    });
  });

  describe('createUsePoisonTool', () => {
    it('应该成功返回使用毒药的意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'witch-1' };
      const tool = createUsePoisonTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 5 });

      expect(result).toEqual({
        action: 'poison',
        actorId: 'witch-1',
        targetSeatNo: 5,
      });
    });

    it('应该允许毒任何座位号', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'witch-1' };
      const tool = createUsePoisonTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 1 });

      expect(result).toEqual({
        action: 'poison',
        actorId: 'witch-1',
        targetSeatNo: 1,
      });
    });
  });
});

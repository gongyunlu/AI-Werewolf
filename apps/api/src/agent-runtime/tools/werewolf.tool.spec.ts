import { createWolfChatTool, createProposeKillTool } from './werewolf.tool';

describe('werewolf.tool', () => {
  describe('createWolfChatTool', () => {
    it('应该成功返回聊天意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createWolfChatTool(ctx);

      const result = await tool.invoke({
        message: '我建议今晚刀3号，他可能是预言家。',
      });

      expect(result).toEqual({
        action: 'wolf_chat',
        actorId: 'wolf-1',
        message: '我建议今晚刀3号，他可能是预言家。',
      });
    });

    it('应该拒绝空消息', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createWolfChatTool(ctx);

      await expect(tool.invoke({ message: '' })).rejects.toThrow();
    });

    it('应该拒绝超长消息', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createWolfChatTool(ctx);
      const longMessage = 'a'.repeat(501);

      await expect(tool.invoke({ message: longMessage })).rejects.toThrow();
    });
  });

  describe('createProposeKillTool', () => {
    it('应该成功返回刀人意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createProposeKillTool(ctx);

      const result = await tool.invoke({
        targetSeatNo: 3,
        reason: '疑似预言家',
      });

      expect(result).toEqual({
        action: 'propose_kill',
        actorId: 'wolf-1',
        targetSeatNo: 3,
        reason: '疑似预言家',
      });
    });

    it('应该允许不提供理由', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createProposeKillTool(ctx);

      const result = await tool.invoke({ targetSeatNo: 5 });

      expect(result).toEqual({
        action: 'propose_kill',
        actorId: 'wolf-1',
        targetSeatNo: 5,
      });
    });

    it('应该允许刀任何座位号（包括自己）', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'wolf-1' };
      const tool = createProposeKillTool(ctx);

      const result = await tool.invoke({
        targetSeatNo: 1, // 假设狼人自己是 1 号
        reason: '自刀骗药',
      });

      expect(result).toEqual({
        action: 'propose_kill',
        actorId: 'wolf-1',
        targetSeatNo: 1,
        reason: '自刀骗药',
      });
    });
  });
});

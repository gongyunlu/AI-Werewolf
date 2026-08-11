import { createMakeSpeechTool } from './make-speech.tool';

describe('make-speech.tool', () => {
  describe('createMakeSpeechTool', () => {
    it('应该成功返回发言意图', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };

      const tool = createMakeSpeechTool(ctx);
      const result = await tool.invoke({
        content: '我认为5号玩家很可疑，他昨晚的发言有问题。',
      });

      expect(result).toEqual({
        action: 'make_speech',
        actorId: 'player-1',
        content: '我认为5号玩家很可疑，他昨晚的发言有问题。',
      });
    });

    it('应该拒绝空发言', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createMakeSpeechTool(ctx);

      await expect(tool.invoke({ content: '' })).rejects.toThrow();
    });

    it('应该拒绝超长发言', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createMakeSpeechTool(ctx);
      const longContent = 'a'.repeat(501);

      await expect(tool.invoke({ content: longContent })).rejects.toThrow();
    });

    it('应该允许包含身份关键词的发言（跳身份是合法策略）', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createMakeSpeechTool(ctx);

      const result = await tool.invoke({
        content: '其实我是狼人，你们来抓我吧。',
      });

      expect(result).toEqual({
        action: 'make_speech',
        actorId: 'player-1',
        content: '其实我是狼人，你们来抓我吧。',
      });
    });

    it('应该允许正常发言', async () => {
      const ctx = { gameId: 'game-1', currentPlayerId: 'player-1' };
      const tool = createMakeSpeechTool(ctx);

      const result = await tool.invoke({
        content: '我认为狼人可能在5号和7号之间。',
      });

      expect(result).toEqual({
        action: 'make_speech',
        actorId: 'player-1',
        content: '我认为狼人可能在5号和7号之间。',
      });
    });
  });
});

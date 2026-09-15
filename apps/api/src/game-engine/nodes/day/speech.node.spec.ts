import { ModelCallError } from '@/llm/model-call-guard';
import { SpeechNode } from './speech.node';
import { createGameState, createPlayer } from '../../testing/test-utils';
import type { NodeContext } from '../node.types';

function createContext(signal?: AbortSignal) {
  return {
    signal,
    broadcaster: { emit: jest.fn() },
    eventWriter: { writePlayerSpeechEvent: jest.fn().mockResolvedValue({}) },
  } as unknown as NodeContext;
}

describe('SpeechNode', () => {
  it('收到正文 chunk 立即广播，此时生成尚未完成且 Event 尚未提交', async () => {
    const context = createContext();
    const runtime = {
      prepareContextPublic: jest.fn().mockResolvedValue({}),
      streamSpeech: jest.fn(async (_input, options: { onContent: (token: string) => void }) => {
        options.onContent('即时首段');
        expect(context.eventWriter.writePlayerSpeechEvent).not.toHaveBeenCalled();
        expect(context.broadcaster?.emit).toHaveBeenCalledWith(
          'game-1',
          expect.objectContaining({
            type: 'scene.append',
            contentType: 'content',
            token: '即时首段',
          }),
        );
        return { thinking: '', content: '即时首段', thinkingDurationMs: 0, contentDurationMs: 1 };
      }),
      recordExperienceUsages: jest.fn().mockResolvedValue(undefined),
    };
    const node = new SpeechNode(runtime as never).create()(context);
    await node(
      createGameState({
        gameId: 'game-1',
        players: [createPlayer('p1', 1, 'villager', 'villager', true)],
      }),
    );
    expect(runtime.streamSpeech).toHaveBeenCalledTimes(1);
    expect(context.eventWriter.writePlayerSpeechEvent).toHaveBeenCalledTimes(1);
  });

  it('把游戏取消信号传给发言调用', async () => {
    const controller = new AbortController();
    const agentRuntime = {
      prepareContextPublic: jest.fn().mockResolvedValue({}),
      streamSpeech: jest.fn().mockResolvedValue({
        thinking: 'thinking',
        content: 'speech',
        thinkingDurationMs: 10,
        contentDurationMs: 20,
      }),
      recordExperienceUsages: jest.fn().mockResolvedValue(undefined),
    };
    const context = createContext(controller.signal);
    const node = new SpeechNode(agentRuntime as never).create()(context);
    const state = createGameState({
      gameId: 'game-1',
      players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
    });

    await node(state);

    expect(agentRuntime.streamSpeech.mock.calls[0][1].signal).toBe(controller.signal);
    expect(agentRuntime.recordExperienceUsages).toHaveBeenCalledTimes(1);
  });

  it('发言失败时上抛，已打开的场景仍然关闭', async () => {
    const agentRuntime = {
      prepareContextPublic: jest.fn().mockResolvedValue({}),
      streamSpeech: jest.fn().mockRejectedValue(new ModelCallError('transient')),
    };
    const context = createContext();
    const node = new SpeechNode(agentRuntime as never).create()(context);
    const state = createGameState({
      gameId: 'game-1',
      players: [createPlayer('player-1', 1, 'villager', 'villager', true)],
    });

    await expect(node(state)).rejects.toMatchObject({ name: 'ModelCallError', code: 'transient' });

    expect(context.broadcaster?.emit).not.toHaveBeenCalledWith(
      'game-1',
      expect.objectContaining({ type: 'scene.append' }),
    );
    expect(context.broadcaster?.emit).toHaveBeenLastCalledWith(
      'game-1',
      expect.objectContaining({
        type: 'scene.close',
        sceneId: JSON.stringify(['game-1', 'node/0/test', 'scene/speech', 'player-1', 0]),
      }),
    );
  });
});

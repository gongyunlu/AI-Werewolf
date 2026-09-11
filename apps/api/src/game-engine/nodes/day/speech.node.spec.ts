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

    expect(agentRuntime.streamSpeech.mock.calls[0][2].signal).toBe(controller.signal);
    expect(agentRuntime.recordExperienceUsages).toHaveBeenCalledTimes(1);
  });

  it('发言失败时仍关闭已打开的场景', async () => {
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

    await node(state);

    expect(context.broadcaster?.emit).toHaveBeenLastCalledWith(
      'game-1',
      expect.objectContaining({ type: 'scene.close', sceneId: 'speech-game-1-1-player-1' }),
    );
  });
});

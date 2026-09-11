import { pairedWolfOrder, wolfDiscussion } from './werewolf-collaboration';
import { createGameState, createPlayer } from '../../testing/test-utils';
import { ModelCallError } from '@/llm/model-call-guard';

jest.mock('@langchain/openai', () => ({ ChatOpenAI: jest.fn() }));

it('配对讨论顺序只由 pair/day/round/seat 决定，不受输入顺序及玩家 UUID 影响', () => {
  const on = [
    { id: 'on-2', seatNo: 2 },
    { id: 'on-6', seatNo: 6 },
  ];
  const off = [
    { id: 'off-6', seatNo: 6 },
    { id: 'off-2', seatNo: 2 },
  ];
  const random = jest.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('unpaired randomness');
  });
  try {
    for (const day of [1, 2])
      for (const round of [0, 1]) {
        expect(pairedWolfOrder(on, 'pair', day, round).map((p) => p.seatNo)).toEqual(
          pairedWolfOrder(off, 'pair', day, round).map((p) => p.seatNo),
        );
      }
    expect(on.map((p) => p.seatNo)).toEqual([2, 6]);
  } finally {
    random.mockRestore();
  }
});

it.each([false, true])('两轮狼聊传入真实顺序与完成状态（首位失败=%s）', async (fails) => {
  const wolves = [
    createPlayer('a', 1, 'werewolf', 'werewolf'),
    createPlayer('b', 2, 'werewolf', 'werewolf'),
  ];
  const state = createGameState({ gameId: 'g', players: wolves }, { currentDay: 2 });
  const runtime = {
    prepareContextPublic: jest.fn().mockResolvedValue({}),
    streamSpeech: jest.fn().mockResolvedValue({
      thinking: '分析',
      content: '本轮讨论',
      thinkingDurationMs: 0,
      contentDurationMs: 0,
    }),
    recordExperienceUsages: jest.fn(),
    runModelCall: jest.fn().mockResolvedValue({ content: 'YES' }),
  };
  if (fails) runtime.streamSpeech.mockRejectedValueOnce(new ModelCallError('transient'));
  const context = {
    agentRuntime: runtime,
    prisma: { game: { findUnique: jest.fn().mockResolvedValue(null) } },
    eventWriter: { writeWolfDiscussionEvent: jest.fn().mockResolvedValue({ id: 'e' }) },
    configService: {
      get: jest.fn().mockReturnValue('test'),
      getOrThrow: jest.fn().mockReturnValue('test'),
    },
    promptService: {
      captureGameSnapshot: jest.fn().mockResolvedValue({}),
      render: jest.fn().mockResolvedValue({ text: '继续讨论吗' }),
    },
  };
  const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    await wolfDiscussion(wolves, state, context as never);
    const requests = runtime.prepareContextPublic.mock.calls.map(([input]) => input);
    expect(requests).toHaveLength(4);
    expect(requests.map((r) => r.position.round)).toEqual([1, 1, 2, 2]);
    for (const request of requests)
      expect(request).toMatchObject({
        actionType: 'speech',
        position: { day: 2, phase: '狼队夜间讨论', aliveSeats: [1, 2], order: [1, 2] },
      });
    expect(requests[1].position).toMatchObject({
      completedSeats: fails ? [] : [1],
      skippedSeats: fails ? [1] : [],
    });
    expect(requests[2].position).toMatchObject({ completedSeats: [], skippedSeats: [] });
    expect(requests[3].position).toMatchObject({ completedSeats: [1], skippedSeats: [] });
    expect(requests.every((r) => !r.additionalContext.includes('本轮讨论'))).toBe(true);
  } finally {
    random.mockRestore();
  }
});

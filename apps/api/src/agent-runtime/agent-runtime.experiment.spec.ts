import { createAgentRuntime } from '../testing/agent-runtime.fixture';

it.each(['on', 'off'])(
  '实验 %s 使用冻结记忆，覆盖进程开关，记录 OFF 输入但不更新普通记忆',
  async (arm) => {
    const experiment = {
      version: 1,
      capturedAt: '2026-09-06T00:00:00.000Z',
      embeddingModel: 'embed',
      arm,
      memories: [],
      prompts: {},
      skills: {},
      globalPatterns: [],
      knowledgeChunkIds: ['frozen-chunk'],
    };
    const game = { id: 'g', rulesetId: 'standard6p', experiment };
    const player = {
      id: 'p',
      gameId: 'g',
      agentId: 'a',
      role: 'seer',
      seatNo: 1,
      memoryLabelSnapshot: 'baseline',
      game,
    };
    const prisma = {
      player: {
        findUnique: jest.fn().mockResolvedValue(player),
        findMany: jest.fn().mockResolvedValue([]),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
      decisionContext: { upsert: jest.fn() },
    };
    const memory = {
      retrieveFrozen: jest.fn().mockResolvedValue({ active: [], lessons: [], playerModels: [] }),
      retrieveExperience: jest.fn(),
      retrieveActiveMemories: jest.fn(),
      recordUsages: jest.fn(),
    };
    const globalMemory = { retrieveActivePatterns: jest.fn() };
    const knowledge = { retrieve: jest.fn().mockResolvedValue([]), recordUsages: jest.fn() };
    const summary = {
      readPersonalJudgments: jest.fn().mockResolvedValue({
        recentSpeeches: [],
        olderSpeechesSummary: [],
        recentJudgments: [],
        olderJudgmentsSummary: [],
      }),
    };
    const service = createAgentRuntime(
      ...([
        { get: jest.fn((key) => (key === 'ARK_EMBEDDING_MODEL' ? 'embed' : arm === 'off')) },
        prisma,
        memory,
        globalMemory,
        knowledge,
        {},
        summary,
        {},
        {},
      ] as unknown as Parameters<typeof createAgentRuntime>),
    );
    const runtime = service as unknown as {
      assembleSystemPrompt: jest.Mock;
    };

    runtime.assembleSystemPrompt = jest.fn().mockResolvedValue('input');

    const context = await service.prepareContextPublic({
      gameId: 'g',
      playerId: 'p',
      scenario: 'night_action',
      actionType: 'seer_check',
      position: { day: 1, phase: 'night_action', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
      additionalContext: '选择查验',
    });
    await service.recordExperienceUsages(context, {
      id: 'e',
      gameId: 'g',
      actorId: 'p',
      day: 1,
      actionType: 'seer_check',
    });
    expect(memory.retrieveFrozen).toHaveBeenCalledWith(
      experiment,
      expect.objectContaining({ label: 'baseline' }),
    );
    expect(memory.retrieveExperience).not.toHaveBeenCalled();
    expect(memory.retrieveActiveMemories).not.toHaveBeenCalled();
    expect(globalMemory.retrieveActivePatterns).not.toHaveBeenCalled();
    expect(memory.recordUsages).not.toHaveBeenCalled();
    expect(prisma.decisionContext.upsert.mock.calls[0][0].create.snapshot.injectionEnabled).toBe(
      arm === 'on',
    );
    if (arm === 'on')
      expect(knowledge.retrieve).toHaveBeenCalledWith(
        expect.any(String),
        'seer',
        'night_action',
        expect.objectContaining({ chunkIds: ['frozen-chunk'] }),
      );
    else expect(knowledge.retrieve).not.toHaveBeenCalled();

    // 审计关联失败不能改变实际检索和已经保存的决策输入。
    Object.assign(prisma, {
      knowledgeRetrieval: {
        updateMany: jest.fn().mockRejectedValue(new Error('audit unavailable')),
      },
    });
    context.retrievalId = 'retrieval';
    await expect(
      service.recordExperienceUsages(context, {
        id: 'e',
        gameId: 'g',
        actorId: 'p',
        day: 1,
        actionType: 'seer_check',
      }),
    ).resolves.toBeUndefined();

    prisma.event.findMany.mockResolvedValue([
      {
        id: 'old-vote',
        day: 1,
        sequence: 1,
        actionType: 'vote',
        visibility: 'public',
        actorId: 'other',
        content: { voteRound: 0, voterSeatNo: 2, targetSeatNo: 3 },
      },
      {
        id: 'new-vote',
        day: 1,
        sequence: 2,
        actionType: 'vote',
        visibility: 'public',
        actorId: 'other',
        content: { voteRound: 1, voterSeatNo: 2, targetSeatNo: 4 },
      },
    ]);
    const pk = await service.prepareContextPublic({
      gameId: 'g',
      playerId: 'p',
      scenario: 'vote',
      actionType: 'vote',
      position: { day: 1, phase: 'vote', round: 1, aliveSeats: [1, 2, 3, 4, 5, 6] },
      additionalContext: 'PK',
    });
    expect(pk.replay?.evidence).toEqual([expect.objectContaining({ id: 'old-vote' })]);

    memory.retrieveFrozen.mockRejectedValue(new Error('embedding unavailable'));
    await expect(
      service.prepareContextPublic({
        gameId: 'g',
        playerId: 'p',
        scenario: 'night_action',
        actionType: 'seer_check',
        position: { day: 1, phase: 'night_action', round: 0, aliveSeats: [1, 2, 3, 4, 5, 6] },
      }),
    ).rejects.toMatchObject({
      name: 'AbortError',
      message: '实验冻结记忆检索失败',
    });
  },
);

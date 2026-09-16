import { ModelGenerationService } from '../llm/model-generation.service';
import { PlayerTurnService } from './player-turn.service';

it('同日不同节点、并发玩家和重新生成使用独立来源，同次多轮调用保持同一 attempt', async () => {
  const observed: any[] = [];
  const langfuse = {
    startAttempt: jest.fn(),
    trace: jest.fn((params) => {
      observed.push(params);
      return { observationId: String(observed.length) };
    }),
  };
  const calls = {
    streamText: jest.fn().mockResolvedValue('完整文本'),
    capability: () => ({ protocol: 'jsonSchema' }),
    resolveAccess: () => ({ baseUrl: 'https://model.test' }),
  };
  const config = {
    get: (key: string) => (key === 'TURN_REFLECTION_MAX_ROUNDS' ? 1 : undefined),
  } as never;
  const model = new ModelGenerationService(config, calls as never, langfuse as never);
  const prompts = {
    render: jest.fn(async (name) => ({ name, text: '冻结模板', version: 2, source: 'langfuse' })),
  };
  const service = new PlayerTurnService(
    ...([config, model, prompts, langfuse] as unknown as ConstructorParameters<
      typeof PlayerTurnService
    >),
  );
  const contexts = ['node/1/speech:p1', 'node/1/speech:p2', 'node/2/speech:p1'].map(
    (actionKey) => ({
      actionKey,
      systemPrompt: '授权上下文',
      scenario: 'day_speech',
      player: { id: actionKey, gameId: 'g', modelName: 'stub' },
      replay: {},
    }),
  );
  await Promise.all(contexts.map((context) => service.speech(context, {})));
  expect(new Set(observed.map((call) => call.source?.attemptId)).size).toBe(3);
  const original = structuredClone((contexts[0] as any).source);
  expect(original.outputObservationId).toBeDefined();
  await service.speech(contexts[0], {});
  expect((contexts[0] as any).source.traceId).toBe(original.traceId);
  expect((contexts[0] as any).source.attemptId).not.toBe(original.attemptId);
});

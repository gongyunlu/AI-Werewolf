import { PromptService } from './prompt.service';
import { PROMPT_NAMES, FALLBACK_TEMPLATES, REQUIRED_PROMPT_VARIABLES } from './prompt-templates';

it('并发首次获取只接受一个版本，后续发布不改变该局，另局可以使用新版本', async () => {
  const data = new Map<string, string>();
  const redis = {
    get: jest.fn(async (key: string) => data.get(key) ?? null),
    set: jest.fn(async (key: string, value: string) => {
      if (data.has(key)) return null;
      data.set(key, value);
      return 'OK';
    }),
  };
  const service = new PromptService({ get: () => undefined } as never, redis as never);
  const name = PROMPT_NAMES.agentTurnContinue;
  let version = 0;
  const capture = jest
    .spyOn(service, 'captureSnapshot')
    .mockImplementation(async () => ({ [name]: { text: 'v' + ++version, version } }));
  const [a, b] = await Promise.all([
    service.captureGameSnapshot('g', [name]),
    service.captureGameSnapshot('g', [name]),
  ]);
  expect(a).toEqual(b);
  expect(await service.captureGameSnapshot('g', [name])).toEqual(a);
  expect(await service.captureGameSnapshot('other', [name])).not.toEqual(a);
  expect(capture).toHaveBeenCalledTimes(3);
});

it('系统模板要求精确回合变量，续写模板不带变量且只追加新增思考', () => {
  expect(REQUIRED_PROMPT_VARIABLES[PROMPT_NAMES.agentSystemPrompt]).toContain('turnContext');
  // 续写提示词接在会话历史之后，上下文由历史承载，因此它自己不能再要求任何占位符
  expect(REQUIRED_PROMPT_VARIABLES[PROMPT_NAMES.agentTurnContinue]).toEqual([]);
  expect(FALLBACK_TEMPLATES[PROMPT_NAMES.agentTurnContinue]).toContain('不要复述');
  // 决策一律要求先验算胜利条件，避免出现能直接终结本局的候选却没被盘过
  expect(FALLBACK_TEMPLATES[PROMPT_NAMES.agentActionSystem]).toContain('验算本局胜利条件');
});

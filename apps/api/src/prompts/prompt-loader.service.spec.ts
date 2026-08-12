import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PromptLoaderService } from './prompt-loader.service';

describe('PromptLoaderService', () => {
  let service: PromptLoaderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptLoaderService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'PROMPTS_DIR') return undefined;
              return 'mock-value';
            }),
          },
        },
      ],
    }).compile();

    service = module.get<PromptLoaderService>(PromptLoaderService);
    await service.onModuleInit();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should load scenario prompts', () => {
    expect(service.has('scenario/vote')).toBe(true);
    expect(service.has('scenario/day-speech')).toBe(true);
    expect(service.has('scenario/night-action')).toBe(true);
    expect(service.has('scenario/last-words')).toBe(true);
  });

  it('should return prompt content', () => {
    const votePrompt = service.get('scenario/vote');
    expect(votePrompt).toContain('投票阶段');
    expect(votePrompt).toContain('cast_vote');
  });

  it('should throw error for non-existent prompt', () => {
    expect(() => service.get('non-existent')).toThrow('Prompt not found');
  });

  it('should return all loaded keys', () => {
    const keys = service.getKeys();
    expect(keys).toContain('scenario/vote');
    expect(keys.length).toBeGreaterThan(0);
  });
});

import { updateLessonMetadata } from './backfill-lesson-trigger';

describe('updateLessonMetadata', () => {
  it('metadata 为 NULL 时用空 jsonb 合并，并保留既有 metadata', async () => {
    const executeRaw = jest.fn().mockResolvedValue(1);
    const executor = { $executeRaw: executeRaw };

    await updateLessonMetadata(executor as never, '00000000-0000-0000-0000-000000000001', {
      role: 'seer',
      scenario: 'vote',
    });

    const [strings, tag, id] = executeRaw.mock.calls[0] as [TemplateStringsArray, string, string];
    expect(strings.join('?')).toContain("COALESCE(metadata, '{}'::jsonb) || ?::jsonb");
    expect(JSON.parse(tag)).toEqual({ role: 'seer', scenario: 'vote' });
    expect(id).toBe('00000000-0000-0000-0000-000000000001');
  });
});

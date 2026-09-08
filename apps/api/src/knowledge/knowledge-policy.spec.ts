import { buildKnowledgeFacts, knowledgeRejection } from './knowledge-policy';
import { KnowledgeService } from './knowledge.service';
import { STANDARD6P_TACTICS } from './standard6p-tactics';

describe('knowledge applicability and deduplication', () => {
  const situation = { rulesetId: 'standard6p', actionType: 'seer_check', facts: ['first_night'] };
  it('仅允许当前板子、当前动作且触发条件已满足的条目', () => {
    const policy = STANDARD6P_TACTICS[0].applicability;
    expect(knowledgeRejection(policy, situation)).toBeNull();
    expect(knowledgeRejection(null, situation)).toBe('unreviewed');
    expect(knowledgeRejection({ ...policy, rulesets: ['mist'] }, situation)).toBe(
      'ruleset_mismatch',
    );
    expect(knowledgeRejection(policy, { ...situation, actionType: 'wolf_explode' })).toBe(
      'action_mismatch',
    );
    expect(knowledgeRejection(policy, { ...situation, facts: [] })).toBe('trigger_mismatch');
  });

  it('高相似度的不适用条目不挤掉后面的有效知识；相同来源只占一个名额，并记录理由', async () => {
    const valid = {
      id: 'valid',
      source_file: 'source',
      article_title: 'title',
      content: 'same',
      role: 'seer',
      scenario: 'night_action',
      trigger: 'first',
      action: 'check',
      similarity: 0.8,
      applicability: STANDARD6P_TACTICS[0].applicability,
    };
    const rows = [
      ...Array.from({ length: 50 }, (_, i) => ({
        ...valid,
        id: `wrong-${i}`,
        applicability: { ...valid.applicability, rulesets: ['mist'] },
      })),
      valid,
      { ...valid, id: 'copy', content: ' same ' },
    ];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      knowledgeRetrieval: { create: jest.fn().mockResolvedValue({ id: 'audit' }) },
    };
    const service = new KnowledgeService(
      ...([
        prisma,
        { embedText: jest.fn().mockResolvedValue([1, 0]) },
      ] as unknown as ConstructorParameters<typeof KnowledgeService>),
    );
    const onAudit = jest.fn();
    const hits = await service.retrieve('query', 'seer', 'night_action', {
      situation,
      gameId: 'g',
      playerId: 'p',
      onAudit,
    });
    expect(hits.map((h) => h.id)).toEqual(['valid']);
    const audit = prisma.knowledgeRetrieval.create.mock.calls[0][0].data.result;
    expect(audit.candidates[0].rejection).toBe('ruleset_mismatch');
    expect(audit.candidates[51].rejection).toBe('duplicate_source');
    expect(onAudit).toHaveBeenCalledWith('audit');
  });

  it('查验和用药状态只从当前玩家可见的已发生事件计算', () => {
    const facts = buildKnowledgeFacts({
      day: 2,
      playerId: 'seer',
      seatNo: 1,
      events: [
        {
          actionType: 'seer_check',
          visibility: 'seer',
          actorId: 'seer',
          content: { result: 'werewolf' },
        },
      ],
    });
    expect(facts).toContain('has_wolf_check');
    expect(facts).not.toContain('first_night');
    expect(facts).not.toContain('public_discussion');
  });
});

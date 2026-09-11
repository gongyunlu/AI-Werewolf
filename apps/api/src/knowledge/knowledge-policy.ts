import { createHash } from 'node:crypto';
import { z } from 'zod';

export const KnowledgeApplicabilitySchema = z.object({
  reviewed: z.boolean(),
  rulesets: z.array(z.string()).min(1),
  actionTypes: z.array(z.string()).min(1),
  allFacts: z.array(
    z.enum([
      'first_night',
      'after_first_night',
      'has_saved',
      'public_discussion',
      'has_check',
      'has_wolf_check',
      'antidote_unused',
      'poison_unused',
      'self_targeted',
    ]),
  ),
});
export type KnowledgeApplicability = z.infer<typeof KnowledgeApplicabilitySchema>;
export interface KnowledgeSituation {
  rulesetId: string;
  actionType: string;
  facts: string[];
}

export function knowledgeRejection(
  applicability: unknown,
  situation?: KnowledgeSituation,
): string | null {
  const parsed = KnowledgeApplicabilitySchema.safeParse(applicability);
  if (!parsed.success || !parsed.data.reviewed) return 'unreviewed';
  if (!situation) return 'missing_situation';
  const policy = parsed.data;
  if (!policy.rulesets.includes(situation.rulesetId)) return 'ruleset_mismatch';
  if (!policy.actionTypes.includes(situation.actionType)) return 'action_mismatch';
  if (!policy.allFacts.every((fact) => situation.facts.includes(fact))) return 'trigger_mismatch';
  return null;
}

export function knowledgeSourceHash(source: {
  sourceFile: string;
  articleTitle: string;
  content: string;
}): string {
  return createHash('sha256')
    .update([source.sourceFile, source.articleTitle, source.content.trim()].join('\n'))
    .digest('hex');
}

export function knowledgeEmbeddingText(chunk: {
  role: string;
  scenario: string;
  trigger: string;
  action: string;
}): string {
  return `角色：${chunk.role}\n场景：${chunk.scenario}\n触发：${chunk.trigger}\n行动：${chunk.action}`;
}

export function buildKnowledgeFacts(input: {
  day: number;
  role?: string | null;
  playerId: string;
  seatNo: number | null;
  events: Array<{
    actionType: string;
    visibility: string;
    actorId?: string | null;
    day?: number | null;
    content: unknown;
  }>;
}): string[] {
  const facts: string[] = [];
  if (input.day === 1) facts.push('first_night');
  if (input.day > 1) facts.push('after_first_night');
  let saved = false;
  let poisoned = false;
  for (const event of input.events) {
    const c = (event.content ?? {}) as Record<string, unknown>;
    if (
      event.actionType === 'speech' &&
      event.visibility === 'public' &&
      typeof c.speech === 'string' &&
      c.speech.trim()
    )
      facts.push('public_discussion');
    if (event.actorId === input.playerId) {
      if (event.actionType === 'seer_check') {
        facts.push('has_check');
        if (c.result === 'werewolf') facts.push('has_wolf_check');
      }
      if (event.actionType === 'witch_save' && c.saved === true) saved = true;
      if (event.actionType === 'witch_poison' && c.used === true) poisoned = true;
    }
  }
  if (saved) facts.push('has_saved');
  if (input.role === 'witch') {
    if (!saved) facts.push('antidote_unused');
    if (!poisoned) facts.push('poison_unused');
  }
  const latestKill = input.events.findLast(
    (e) => e.actionType === 'wolf_kill' && e.day === input.day,
  );
  if (latestKill && (latestKill.content as Record<string, unknown>).targetSeatNo === input.seatNo)
    facts.push('self_targeted');
  return [...new Set(facts)];
}

import { z } from 'zod';
import { throwIfAborted } from '../llm/abort.utils';

export const TurnReviewSchema = z.object({
  issues: z.array(
    z.object({
      kind: z.enum([
        'unsupported_fact',
        'timeline',
        'claim_change',
        'action_reason',
        'experience',
        'rule_branch',
      ]),
      explanation: z.string().min(1),
      evidenceSequences: z.array(z.number().int().nonnegative()),
    }),
  ),
});
export type TurnReview = z.infer<typeof TurnReviewSchema>;
export type ReflectionStatus =
  'passed' | 'disabled' | 'limit_reached' | 'no_progress' | 'unsupported_review';

export const SpeechRevisionSchema = z.object({
  reasoning: z.string().min(1),
  contentEdits: z.array(z.object({ before: z.string().min(1), after: z.string() })),
});

/** 所有替换都定位到同一份原稿，禁止模糊匹配、重复定位和相互覆盖。 */
export function applySpeechRevision(
  candidate: { reasoning: string; content: string },
  revision: z.infer<typeof SpeechRevisionSchema>,
): { reasoning: string; content: string } {
  const edits = revision.contentEdits
    .map((edit, index) => {
      const start = candidate.content.indexOf(edit.before);
      if (start < 0 || candidate.content.indexOf(edit.before, start + 1) >= 0)
        throw new Error(
          `contentEdits[${index}].before 必须在原稿中完整且唯一出现，请逐字保留原文的标点、空格和换行`,
        );
      return { ...edit, start, end: start + edit.before.length };
    })
    .toSorted((a, b) => a.start - b.start);
  for (let i = 1; i < edits.length; i++) {
    if (edits[i].start < edits[i - 1].end) throw new Error('contentEdits 不可重叠');
  }
  let content = candidate.content;
  for (const edit of edits.toReversed())
    content = content.slice(0, edit.start) + edit.after + content.slice(edit.end);
  if (!content.trim()) throw new Error('修订后的发言不可为空');
  return { reasoning: revision.reasoning, content };
}
export interface ReflectionAudit<T> {
  status: ReflectionStatus;
  initial: T;
  rounds: Array<{ candidate: T; review: TurnReview; revision?: T }>;
  final: T;
}

/** 复核只产生候选结果，规则校验和副作用由调用方负责。 */
export async function reflectTurn<T>(options: {
  initial: T;
  maxRounds: number;
  signal?: AbortSignal;
  evidenceSequences: ReadonlySet<number>;
  review: (candidate: T, round: number) => Promise<TurnReview>;
  revise: (candidate: T, review: TurnReview, round: number) => Promise<T>;
}): Promise<ReflectionAudit<T>> {
  const audit: ReflectionAudit<T> = {
    status: 'disabled',
    initial: options.initial,
    rounds: [],
    final: options.initial,
  };
  for (let round = 1; round <= options.maxRounds; round++) {
    throwIfAborted(options.signal);
    const review = TurnReviewSchema.parse(await options.review(audit.final, round));
    throwIfAborted(options.signal);
    const entry: ReflectionAudit<T>['rounds'][number] = { candidate: audit.final, review };
    audit.rounds.push(entry);
    if (
      review.issues.some((issue) =>
        issue.evidenceSequences.some((seq) => !options.evidenceSequences.has(seq)),
      )
    ) {
      audit.status = 'unsupported_review';
      return audit;
    }
    if (!review.issues.length) {
      audit.status = 'passed';
      return audit;
    }
    if (round === options.maxRounds) {
      audit.status = 'limit_reached';
      return audit;
    }
    const revision = await options.revise(audit.final, review, round);
    throwIfAborted(options.signal);
    entry.revision = revision;
    if (JSON.stringify(revision) === JSON.stringify(audit.final)) {
      audit.status = 'no_progress';
      return audit;
    }
    audit.final = revision;
  }
  return audit;
}

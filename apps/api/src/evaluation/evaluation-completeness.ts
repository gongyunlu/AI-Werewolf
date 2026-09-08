import { isJudgeableAction } from './action-catalog';
import { EVALUATION_VERSION } from './evaluation-version';

type EvaluationEvent = { id: string; actorId: string | null; actionType: string; content: unknown };

export function judgeableEventIds(events: EvaluationEvent[]): string[] {
  return events
    .filter((e) => {
      const content = (e.content ?? {}) as Record<string, unknown>;
      if (e.actionType === 'speech')
        return Boolean(e.actorId && typeof content.speech === 'string' && content.speech.trim());
      return Boolean(
        (e.actorId || e.actionType === 'wolf_kill') && isJudgeableAction(e.actionType, content),
      );
    })
    .map((e) => e.id);
}

export function evaluationCompleteness(input: {
  run: { id: string; status: string; expectedEventIds: string[] } | null;
  events: EvaluationEvent[];
  judgments: Array<{ eventId: string; evaluationRunId: string | null; evaluationVersion: number }>;
}): { complete: boolean; missing: string[]; reasons: string[] } {
  const expected = judgeableEventIds(input.events);
  const reasons: string[] = [];
  if (!input.run || input.run.status !== 'complete') reasons.push('evaluation_run_incomplete');
  const expectedRun = new Set(input.run?.expectedEventIds ?? []);
  if (expected.length !== expectedRun.size || expected.some((id) => !expectedRun.has(id)))
    reasons.push('evaluation_target_mismatch');
  const scored = new Set(
    input.judgments
      .filter(
        (j) =>
          input.run &&
          j.evaluationRunId === input.run.id &&
          j.evaluationVersion === EVALUATION_VERSION,
      )
      .map((j) => j.eventId),
  );
  const missing = expected.filter((id) => !scored.has(id));
  if (missing.length) reasons.push('missing_or_stale_judgments');
  return { complete: !reasons.length, missing, reasons };
}

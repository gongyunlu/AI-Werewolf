import { backfillMemoryRewards } from './memory-reward';
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Prisma, type EvaluationRun, type Event } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PromptService } from '../observability/prompt.service';
import { StructuredLlmService } from '../observability/structured-llm.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { traceIdentity, type ActionSource } from '../observability/action-source';
import { readExperiment, type FrozenPrompts } from './experiment-snapshot';
import { EVALUATION_VERSION } from './evaluation-version';
import { judgeableEventIds } from './evaluation-completeness';
import {
  LangfuseScoresService,
  SCORE_NAMES,
  scoreReferences,
  selectScore,
  type ScoreConfigReference,
  type ScoreReference,
  type PlatformScore,
  type IngestionEvent,
} from './langfuse-scores.service';

export interface EvaluationDefinition {
  id: string;
  projectId: string;
  domainVersion: number;
  modelName: string;
  baseUrl: string;
  prompts?: FrozenPrompts;
  configurations: Record<'quality' | 'verdict', ScoreConfigReference>;
}
export interface EvaluatedResult {
  score: number;
  verdict: string;
  reasoning: string;
  modelName: string;
  /** 精确的授权判分输入，仅为可靠交付暂存，采用后清除。 */
  input?: Record<string, unknown>;
}
type PendingResult = {
  token: string;
  instanceId: string;
  leaseUntil: string;
  result?: EvaluatedResult;
};
export interface AdoptScoresInput {
  runId: string;
  definitionRunId: string;
  selections: Array<{ eventId: string; quality: ScoreReference; verdict: ScoreReference }>;
}
type Selection = Record<string, { quality: ScoreReference; verdict: ScoreReference }>;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const pending = (run: EvaluationRun) =>
  run.pendingResults as unknown as Record<string, PendingResult>;
const definition = (run: EvaluationRun) => run.definition as unknown as EvaluationDefinition;
const evaluationTrace = (runId: string) => traceIdentity('evaluation', runId);

/** 平台管理评分；本表只负责冻结、交付重试与整批业务采用，不维护新评分历史。 */
@Injectable()
export class EvaluationProjectionService {
  /** 本进程身份。暂存租约只对本进程内的并发有效，跨进程的记录一律视为上一进程的遗留。 */
  private readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptService,
    private readonly llm: StructuredLlmService,
    private readonly platform: LangfuseScoresService,
  ) {}

  async begin(gameId: string, runId: string): Promise<void> {
    const existing = await this.prisma.evaluationRun.findUnique({ where: { id: runId } });
    if (existing) {
      if (existing.gameId !== gameId) throw new Error('评分运行与对局不匹配');
      // 历史运行不伪造来源；完成的旧任务保持只读，未完成的由新运行显式补评。
      if (!existing.definition && existing.status !== 'complete')
        throw new Error('历史未完成评估需创建新的平台运行');
      return;
    }
    const game = await this.prisma.game.findUniqueOrThrow({
      where: { id: gameId },
      select: { status: true, experiment: true },
    });
    const experiment = readExperiment(game.experiment);
    if (game.status !== 'finished' || experiment?.invalid)
      throw new Error('仅允许为有效已结束对局创建评分批次');
    const [events, project, configurations, frozen] = await Promise.all([
      this.prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } }),
      this.platform.project(),
      this.platform.configurations(),
      experiment?.prompts ??
        this.prompts.captureSnapshot([
          PROMPT_NAMES.judgeSystem,
          PROMPT_NAMES.judgeUser,
          PROMPT_NAMES.judgeRefineSystem,
          PROMPT_NAMES.judgeSpeechSystem,
          PROMPT_NAMES.judgeSpeechUser,
          PROMPT_NAMES.judgeSpeechRefineSystem,
        ]),
    ]);
    const model = this.llm.captureConfiguration(experiment?.judgeModel);
    const body = {
      projectId: project.id,
      domainVersion: EVALUATION_VERSION,
      ...model,
      prompts: frozen,
      configurations,
    };
    const frozenDefinition: EvaluationDefinition = {
      ...body,
      id: traceIdentity('werewolf-reflective-evaluator', JSON.stringify(body)),
    };
    const run = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
      const duplicate = await tx.evaluationRun.findUnique({ where: { id: runId } });
      if (duplicate) return duplicate;
      const latest = await tx.evaluationRun.findFirst({
        where: { gameId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      await this.supersedePending(tx, gameId);
      return tx.evaluationRun.upsert({
        where: { id: runId },
        update: {},
        create: {
          id: runId,
          gameId,
          expectedEventIds: judgeableEventIds(events),
          definition: json(frozenDefinition),
          createdAt: new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1)),
        },
      });
    });
    await this.publishDefinition(run);
  }

  /** 队列换 jobId 以恢复交付时，复用原评估运行和原判分；只有主动重评才换 runId。 */
  async resumableRun(gameId: string): Promise<string | undefined> {
    const latest = await this.prisma.evaluationRun.findFirst({
      where: { gameId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return latest?.definition && latest.status !== 'complete' && latest.status !== 'superseded'
      ? latest.id
      : undefined;
  }

  async evaluate(
    gameId: string,
    eventId: string,
    runId: string,
    compute: (definition: EvaluationDefinition, source: ActionSource) => Promise<EvaluatedResult>,
  ): Promise<void> {
    const token = randomUUID();
    const claimed = await this.changeRun(runId, async (tx, run) => {
      if (run.gameId !== gameId || !run.expectedEventIds.includes(eventId))
        throw new Error('评分目标不属于本批已提交行动');
      if (run.status === 'complete') return { skip: true, run };
      if (run.status === 'superseded') throw new Error('迟到的旧评分运行不得重新判分');
      // 人工选择的恢复只由父 completion 回读采用，不能当成缺少模型结果再次判分。
      if (run.selection) return { skip: true, run };
      const latest = await tx.evaluationRun.findFirst({
        where: { gameId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== runId) throw new Error('迟到的旧评分运行不得重新判分');
      if (!run.definition) throw new Error('历史评估缺少平台定义，禁止冒标来源');
      if (run.deliveredEventIds.includes(eventId)) return { skip: true, run };
      const entries = pending(run);
      const saved = entries[eventId];
      if (saved?.result) return { skip: false, run, saved: saved.result };
      // 死在本进程里的租约没人会释放，只挡真实并发：上一进程的遗留租约由本次判分接管。
      if (saved?.instanceId === this.instanceId && Date.parse(saved.leaseUntil) > Date.now())
        throw new Error('该行动已有判分进行中');
      entries[eventId] = {
        token,
        instanceId: this.instanceId,
        leaseUntil: new Date(Date.now() + 25 * 60_000).toISOString(),
      };
      await tx.evaluationRun.update({
        where: { id: runId },
        data: { pendingResults: json(entries) },
      });
      return { skip: false, run };
    });
    if (claimed.skip) return;
    let result = claimed.saved;
    if (!result) {
      try {
        await this.publishDefinition(claimed.run, eventId);
        const frozen = definition(claimed.run);
        if (!frozen.prompts) throw new Error('未完成评估缺少冻结 Prompt');
        result = await compute(frozen, {
          actionKey: runId + '/' + eventId,
          traceId: evaluationTrace(runId),
          attemptId: traceIdentity('judge-target', runId, eventId),
          startedAt: claimed.run.createdAt.toISOString(),
        });
        this.validateResult(result);
        await this.changeRun(runId, async (tx, run) => {
          const entries = pending(run);
          if (entries[eventId]?.token !== token) throw new Error('判分执行权已过期');
          entries[eventId] = { ...entries[eventId], result };
          await tx.evaluationRun.update({
            where: { id: runId },
            data: { pendingResults: json(entries) },
          });
        });
      } catch (error) {
        await this.changeRun(runId, async (tx, run) => {
          const entries = pending(run);
          if (entries[eventId]?.token === token && !entries[eventId].result) {
            delete entries[eventId];
            await tx.evaluationRun.update({
              where: { id: runId },
              data: { pendingResults: json(entries) },
            });
          }
        });
        throw error;
      }
    }
    // 从此只重试交付。先持久化最终判分，再进行任何平台网络请求。
    await this.deliver(claimed.run, eventId, result);
  }

  private async deliver(
    run: EvaluationRun,
    eventId: string,
    result: EvaluatedResult,
  ): Promise<void> {
    const event = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const target = this.target(event);
    const frozen = definition(run);
    await this.assertProject(frozen);
    const refs = scoreReferences(run.id, eventId, run.createdAt.toISOString());
    const scores = await this.platform.readScores([refs.quality.id, refs.verdict.id]);
    const proposed = (event.content as Record<string, unknown>).proposalEventIds;
    const proposalIds =
      event.actionType === 'wolf_kill' && Array.isArray(proposed)
        ? proposed.filter((id): id is string => typeof id === 'string')
        : [];
    const [batches, proposals] = await Promise.all([
      this.prisma.effectBatchCommit.findMany({
        where: { gameId: run.gameId, eventIds: { hasSome: [eventId, ...proposalIds] } },
        select: { batchKey: true, eventIds: true },
      }),
      proposalIds.length
        ? this.prisma.event.findMany({
            where: {
              gameId: run.gameId,
              id: { in: proposalIds },
              actionType: 'wolf_proposal',
              sequence: { lt: event.sequence },
            },
            select: { id: true, effectKey: true, source: true },
          })
        : [],
    ]);
    const batchKey = (id: string) =>
      batches.find((batch) => batch.eventIds.includes(id))?.batchKey ?? null;
    const metadata = {
      gameId: run.gameId,
      eventId,
      effectKey: event.effectKey,
      batchKey: batchKey(eventId),
      teamProposals: proposals.map((proposal) => ({
        eventId: proposal.id,
        actionKey: proposal.effectKey,
        source: proposal.source,
        batchKey: batchKey(proposal.id),
      })),
      actionSource: event.source,
      adoptedModelOutput: Boolean(event.source),
      evaluationRunId: run.id,
      definitionId: frozen.id,
      domainVersion: frozen.domainVersion,
      modelName: result.modelName,
    };
    const quality = selectScore(scores, refs.quality),
      verdict = selectScore(scores, refs.verdict);
    const observations: IngestionEvent[] = [
      this.observation('trace-create', event.createdAt.toISOString(), {
        id: target.traceId,
        name: event.source ? 'player-action' : 'committed-action',
        sessionId: event.gameId,
        userId: event.actorId ?? undefined,
        metadata: {
          actionKey: event.effectKey,
          legacyGenerationUnavailable: !event.effectKey && !event.source,
          adoptedModelOutput: Boolean(event.source),
        },
      }),
      this.observation('span-create', event.createdAt.toISOString(), {
        id: target.observationId,
        traceId: target.traceId,
        name: 'committed-action',
        startTime: event.createdAt.toISOString(),
        endTime: event.createdAt.toISOString(),
        input: { actionType: event.actionType, decisionAt: event.sequence, day: event.day },
        output: event.content,
        metadata,
      }),
      this.observation(
        'span-create',
        // 4.15 按外层时间合并更新；最终正文必须晚于开始记录，Score 日期仍保持冻结。
        new Date(Math.max(Date.now(), run.createdAt.getTime() + 1)).toISOString(),
        {
          id: traceIdentity('judge-target', run.id, eventId),
          traceId: evaluationTrace(run.id),
          name: 'domain-evaluator',
          startTime: run.createdAt.toISOString(),
          endTime: new Date().toISOString(),
          input: result.input,
          output: { score: result.score, verdict: result.verdict, reasoning: result.reasoning },
          metadata,
        },
      ),
    ];
    if (!quality || !verdict) {
      await this.platform.writeScores(
        [
          {
            ...refs.quality,
            ...target,
            value: result.score,
            dataType: 'NUMERIC',
            configId: frozen.configurations.quality.id,
            comment: result.reasoning,
            metadata,
          },
          {
            ...refs.verdict,
            ...target,
            value: result.verdict,
            dataType: 'CATEGORICAL',
            configId: frozen.configurations.verdict.id,
            comment: result.reasoning,
            metadata,
          },
        ],
        observations,
      );
    } else {
      // Scores 可见不代表同批 observation 已接收；补齐正文后才登记交付完成。
      await this.platform.ingest(observations);
    }
    const visible =
      quality && verdict
        ? scores
        : await this.platform.readScores([refs.quality.id, refs.verdict.id]);
    this.readResult(visible, refs, frozen, target, run.id);
    await this.changeRun(run.id, async (tx, current) => {
      if (current.status === 'superseded' || current.status === 'complete') return;
      if (!current.deliveredEventIds.includes(eventId))
        await tx.evaluationRun.update({
          where: { id: run.id },
          data: { deliveredEventIds: { push: eventId } },
        });
    });
  }

  /** 全部 Score 可验证后一次替换投影；旧运行迟到不影响已采用的新版本。 */
  async complete(gameId: string, runId: string): Promise<void> {
    const run = await this.prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.gameId !== gameId) throw new Error('评分批次与对局不匹配');
    if (run.status === 'superseded') throw new Error('迟到的旧评分运行不能覆盖新采用结果');
    if (!run.definition) {
      if (run.status === 'complete') return;
      throw new Error('历史未完成评分需要显式平台补评');
    }
    if (run.status === 'complete') return;
    const frozen = definition(run);
    const events = await this.prisma.event.findMany({
      where: { gameId },
      orderBy: { sequence: 'asc' },
    });
    const expected = judgeableEventIds(events);
    if (
      expected.length !== run.expectedEventIds.length ||
      expected.some((id) => !run.expectedEventIds.includes(id))
    )
      throw new Error('评分目标集合已改变');
    const selections = run.selection as unknown as Selection | null;
    if (
      !selections &&
      run.expectedEventIds.some((id) => !run.deliveredEventIds.includes(id)) &&
      run.status !== 'complete'
    )
      throw new Error('评分批次尚未完整交付');
    const refs = Object.fromEntries(
      run.expectedEventIds.map((id) => [
        id,
        selections?.[id] ?? scoreReferences(runId, id, run.createdAt.toISOString()),
      ]),
    );
    const scores = await this.platform.readScores(
      Object.values(refs).flatMap((ref) => [ref.quality.id, ref.verdict.id]),
    );
    const rows = events
      .filter((event) => run.expectedEventIds.includes(event.id))
      .map((event) => {
        const target = this.target(event);
        const result = this.readResult(
          scores,
          refs[event.id],
          frozen,
          target,
          selections ? undefined : run.id,
        );
        return {
          event,
          result,
          source: {
            platform: 'langfuse',
            projectId: frozen.projectId,
            evaluationRunId: run.id,
            definitionId: frozen.id,
            ...target,
            ...refs[event.id],
          },
        };
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
      const latest = await tx.evaluationRun.findFirst({
        where: { gameId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== runId) throw new Error('迟到的旧评分运行不能覆盖新采用结果');
      if (latest.status === 'complete') return;
      for (const { event, result, source } of rows) {
        const common = {
          ...result,
          source: json(source),
          evaluationVersion: frozen.domainVersion,
          evaluationRunId: runId,
        };
        // previousEvaluations 只保留历史原值，从此不再追加评分历史。
        if (event.actionType === 'wolf_kill')
          await tx.teamJudgment.upsert({
            where: { eventId: event.id },
            update: common,
            create: {
              ...common,
              gameId,
              eventId: event.id,
              faction: 'werewolf',
              actionType: event.actionType,
            },
          });
        else {
          if (!event.actorId) throw new Error('个人评分缺少玩家');
          const content = event.content as Record<string, unknown>;
          await tx.decisionJudgment.upsert({
            where: { eventId: event.id },
            update: common,
            create: {
              ...common,
              gameId,
              eventId: event.id,
              playerId: event.actorId,
              actionType: event.actionType,
              day: event.day ?? 0,
              targetSeatNo: typeof content.targetSeatNo === 'number' ? content.targetSeatNo : null,
            },
          });
        }
      }
      await backfillMemoryRewards(tx, gameId);
      const { prompts: _prompts, ...references } = frozen;
      await tx.evaluationRun.update({
        where: { id: runId },
        data: {
          status: 'complete',
          completedAt: new Date(),
          pendingResults: {},
          deliveredEventIds: [],
          definition: json(references),
        },
      });
    });
  }

  /** 人工或外部结果只能通过明确的完整集合采用；禁止自动选择“最新分数”。 */
  async adopt(gameId: string, input: AdoptScoresInput): Promise<void> {
    const original = await this.prisma.evaluationRun.findUniqueOrThrow({
      where: { id: input.definitionRunId },
    });
    if (original.gameId !== gameId || original.status !== 'complete' || !original.definition)
      throw new Error('采用需引用已完成的平台评估定义');
    const selection = Object.fromEntries(
      input.selections.map(({ eventId, ...refs }) => [eventId, refs]),
    );
    if (
      Object.keys(selection).length !== input.selections.length ||
      input.selections.length !== original.expectedEventIds.length ||
      original.expectedEventIds.some((id) => !selection[id])
    )
      throw new Error('采用必须明确选择全部行动，且不得重复');
    for (const refs of Object.values(selection)) {
      for (const key of ['quality', 'verdict'] as const) {
        if (
          !refs[key].id ||
          refs[key].name !== SCORE_NAMES[key] ||
          !Number.isFinite(Date.parse(refs[key].timestamp))
        )
          throw new Error('评分身份必须包含正确的 ID、维度名称与原始日期');
        refs[key].timestamp = new Date(refs[key].timestamp).toISOString();
      }
    }
    const existing = await this.prisma.evaluationRun.findUnique({ where: { id: input.runId } });
    if (existing) {
      if (
        existing.gameId !== gameId ||
        !existing.selection ||
        !isDeepStrictEqual(existing.selection, json(selection)) ||
        !isDeepStrictEqual(existing.definition, original.definition)
      )
        throw new Error('已存在的采用运行不能更换选择');
      await this.complete(gameId, input.runId);
      return;
    }
    const frozen = definition(original);
    const events = await this.prisma.event.findMany({
      where: { gameId, id: { in: original.expectedEventIds } },
    });
    const scores = await this.platform.readScores(
      Object.values(selection).flatMap((refs) => [refs.quality.id, refs.verdict.id]),
    );
    for (const event of events)
      this.readResult(scores, selection[event.id], frozen, this.target(event));
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
      const latest = await tx.evaluationRun.findFirst({
        where: { gameId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      if (latest?.id !== original.id) throw new Error('采用期间评估版本已改变，请重新选择');
      await tx.evaluationRun.create({
        data: {
          id: input.runId,
          gameId,
          expectedEventIds: original.expectedEventIds,
          definition: json(frozen),
          selection: json(selection),
          createdAt: new Date(Math.max(Date.now(), original.createdAt.getTime() + 1)),
        },
      });
    });
    await this.complete(gameId, input.runId);
  }

  private readResult(
    scores: PlatformScore[],
    refs: { quality: ScoreReference; verdict: ScoreReference },
    frozen: EvaluationDefinition,
    target: { traceId: string; observationId: string },
    runId?: string,
  ): EvaluatedResult {
    const quality = selectScore(scores, refs.quality),
      verdict = selectScore(scores, refs.verdict);
    for (const [score, config] of [
      [quality, frozen.configurations.quality],
      [verdict, frozen.configurations.verdict],
    ] as const) {
      if (!score) throw new Error('平台评分尚未完整可见，稍后只重试交付或采用');
      if (
        score.projectId !== frozen.projectId ||
        score.configId !== config.id ||
        score.subject?.kind !== 'observation' ||
        score.subject.id !== target.observationId ||
        score.subject.traceId !== target.traceId
      )
        throw new Error('平台评分对象或定义不匹配');
      if (
        runId &&
        (score.metadata?.evaluationRunId !== runId || score.metadata.definitionId !== frozen.id)
      )
        throw new Error('平台评分运行版本不匹配');
    }
    if (quality!.dataType !== 'NUMERIC' || verdict!.dataType !== 'CATEGORICAL')
      throw new Error('平台评分维度类型不匹配');
    const result = {
      score: quality!.value as number,
      verdict: verdict!.value as string,
      reasoning: quality!.comment ?? '',
      modelName: runId ? frozen.modelName : `langfuse:${quality!.source}`,
    };
    this.validateResult(result);
    return result;
  }

  private validateResult(result: EvaluatedResult): void {
    if (
      !Number.isInteger(result.score) ||
      result.score < 0 ||
      result.score > 100 ||
      !['poor', 'fair', 'good'].includes(result.verdict) ||
      !result.reasoning.trim() ||
      result.reasoning.length > 500
    )
      throw new Error('评分不符合原领域尺度、结论或理由要求');
  }

  private target(event: Event) {
    const source = event.source as unknown as ActionSource | null;
    return {
      traceId:
        source?.traceId ??
        (event.effectKey
          ? traceIdentity('action', event.effectKey)
          : traceIdentity('event', event.id)),
      observationId: traceIdentity('committed', event.id),
    };
  }

  private observation(
    type: IngestionEvent['type'],
    timestamp: string,
    body: Record<string, unknown>,
  ): IngestionEvent {
    // 交付请求身份与业务对象身份分开；不同内容更新不能复用接收端的去重键。
    return { type, id: randomUUID(), timestamp, body };
  }

  private async publishDefinition(run: EvaluationRun, eventId?: string): Promise<void> {
    const frozen = definition(run);
    // 并发登记可能在事务内命中已采用/已替代运行；精简引用不能覆盖平台完整定义。
    if (run.status !== 'pending' || !frozen.prompts) return;
    await this.assertProject(frozen);
    await this.platform.ingest([
      this.observation('trace-create', run.createdAt.toISOString(), {
        id: frozen.id,
        name: 'werewolf-evaluator-definition',
        input: frozen,
        metadata: {
          domainVersion: frozen.domainVersion,
          evaluator: '初判及一次反思修正',
          projectId: frozen.projectId,
        },
      }),
      this.observation('trace-create', run.createdAt.toISOString(), {
        id: evaluationTrace(run.id),
        name: 'werewolf-evaluation-run',
        sessionId: run.gameId,
        input: { expectedEventIds: run.expectedEventIds },
        metadata: { evaluationRunId: run.id, definitionId: frozen.id },
      }),
      ...(eventId
        ? [
            this.observation('span-create', run.createdAt.toISOString(), {
              id: traceIdentity('judge-target', run.id, eventId),
              traceId: evaluationTrace(run.id),
              name: 'domain-evaluator',
              startTime: new Date().toISOString(),
              input: { eventId },
              metadata: {
                gameId: run.gameId,
                eventId,
                evaluationRunId: run.id,
                definitionId: frozen.id,
              },
            }),
          ]
        : []),
    ]);
  }

  private async assertProject(frozen: EvaluationDefinition): Promise<void> {
    if ((await this.platform.project()).id !== frozen.projectId)
      throw new Error('Langfuse 凭证对应项目已改变，禁止交付冻结运行到其他项目');
  }

  private async supersedePending(tx: Prisma.TransactionClient, gameId: string): Promise<void> {
    const previous = await tx.evaluationRun.findMany({
      where: { gameId, status: { notIn: ['complete', 'superseded'] } },
    });
    for (const run of previous) {
      const { prompts: _prompts, ...references } = definition(run) ?? {};
      await tx.evaluationRun.update({
        where: { id: run.id },
        data: {
          status: 'superseded',
          pendingResults: {},
          deliveredEventIds: [],
          ...(run.definition ? { definition: json(references) } : {}),
        },
      });
    }
  }

  private async changeRun<T>(
    runId: string,
    action: (tx: Prisma.TransactionClient, run: EvaluationRun) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM evaluation_runs WHERE id = ${runId} FOR UPDATE`;
      return action(tx, await tx.evaluationRun.findUniqueOrThrow({ where: { id: runId } }));
    });
  }
}

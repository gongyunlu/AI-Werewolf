import { backfillMemoryRewards } from './memory-reward';
import { aggregatePlayerScores } from './player-score';
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
  type ScoreDestination,
} from './langfuse-scores.service';

export interface EvaluationDefinition {
  id: string;
  projectId?: string;
  destination?: ScoreDestination;
  domainVersion: number;
  modelName: string;
  baseUrl: string;
  prompts?: FrozenPrompts;
  configurations?: Record<'quality' | 'verdict', ScoreConfigReference>;
}
export interface EvaluatedResult {
  score: number;
  verdict: string;
  reasoning: string;
  modelName: string;
  /** 精确的授权判分输入，业务采用和平台接收均完成后清除。 */
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

/** 自动评分采用本地最终结果；平台上报与显式采用外部评分各自保留来源。 */
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
    const [events, frozen] = await Promise.all([
      this.prisma.event.findMany({ where: { gameId }, orderBy: { sequence: 'asc' } }),
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
      destination: this.platform.destination(),
      domainVersion: EVALUATION_VERSION,
      ...model,
      prompts: frozen,
    };
    const frozenDefinition: EvaluationDefinition = {
      ...body,
      id: traceIdentity('werewolf-reflective-evaluator', JSON.stringify(body)),
    };
    await this.prisma.$transaction(async (tx) => {
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
  }

  /** 判分队列恢复时复用原运行和已保存结果；只有主动重评才换 runId。 */
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
      const entries = pending(run);
      const saved = entries[eventId];
      if (saved?.result) return { skip: true, run };
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
    try {
      const frozen = definition(claimed.run);
      if (!frozen.prompts) throw new Error('未完成评估缺少冻结 Prompt');
      const result = await compute(frozen, {
        actionKey: runId + '/' + eventId,
        traceId: evaluationTrace(runId),
        attemptId: traceIdentity('judge-target', runId, eventId),
        startedAt: claimed.run.createdAt.toISOString(),
      });
      this.validateResult(result);
      await this.changeRun(runId, async (tx, run) => {
        const entries = pending(run);
        if (entries[eventId]?.token !== token) throw new Error('判分执行权已过期');
        // 保存最终结果就是持久上报意图；队列未投递或进程退出都不丢失。
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

  /** 独立交付任务只消费持久结果，绝不调用裁判，也不改变业务完成状态。 */
  async deliverPending(runId: string): Promise<void> {
    let run = await this.prisma.evaluationRun.findUniqueOrThrow({ where: { id: runId } });
    const entries = Object.entries(pending(run)).filter(
      ([id, entry]) => entry.result && !run.deliveredEventIds.includes(id),
    );
    if (!entries.length) return;
    run = await this.bindDeliveryProject(run);
    await this.publishDefinition(run);
    for (const [eventId, entry] of entries) await this.deliver(run, eventId, entry.result!);
  }

  private async deliver(
    run: EvaluationRun,
    eventId: string,
    result: EvaluatedResult,
  ): Promise<void> {
    const event = await this.prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const target = this.target(event);
    const frozen = definition(run);
    if (!frozen.projectId || !frozen.configurations) throw new Error('上报缺少平台项目或评分配置');
    const refs = scoreReferences(run.id, eventId, run.createdAt.toISOString());
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
        // 正文按实际交付时间更新；Score 日期保持冻结，跨日重试仍指向同一评分。
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
    // 成功回包只确认接收。响应丢失时重交相同 Score 身份，不等待平台查询可见。
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
    await this.changeRun(run.id, async (tx, current) => {
      if (!current.deliveredEventIds.includes(eventId))
        await tx.evaluationRun.update({
          where: { id: run.id },
          data:
            current.status === 'pending'
              ? { deliveredEventIds: { push: eventId } }
              : this.retainUndelivered({
                  ...current,
                  deliveredEventIds: [...current.deliveredEventIds, eventId],
                }),
        });
    });
  }

  /** 自动批次采用本地完整结果；平台交付独立推进，显式选择的外部评分才需要回读。 */
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
    const refs = Object.fromEntries(
      run.expectedEventIds.map((id) => [
        id,
        selections?.[id] ?? scoreReferences(runId, id, run.createdAt.toISOString()),
      ]),
    );
    const scores = selections
      ? await this.platform.readScores(
          Object.values(refs).flatMap((ref) => [ref.quality.id, ref.verdict.id]),
        )
      : [];
    const saved = pending(run);
    const rows = events
      .filter((event) => run.expectedEventIds.includes(event.id))
      .map((event) => {
        const target = this.target(event);
        const result = selections
          ? this.readResult(scores, refs[event.id], frozen, target)
          : saved[event.id]?.result;
        if (!result) throw new Error('评分批次缺少本地最终评分，禁止从平台代填');
        this.validateResult(result);
        return {
          event,
          // 输入正文只用于交付，不能混入业务评分或在采用后继续保留副本。
          result: {
            score: result.score,
            verdict: result.verdict,
            reasoning: result.reasoning,
            modelName: result.modelName,
          },
          source: {
            resultOrigin: selections ? 'langfuse' : 'local_evaluator',
            platform: 'langfuse',
            projectId: frozen.projectId,
            destination: frozen.destination,
            evaluationRunId: run.id,
            definitionId: frozen.id,
            ...target,
            ...refs[event.id],
          },
        };
      });
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evaluation/${gameId}`}, 0))`;
      await tx.$executeRaw`SELECT id FROM evaluation_runs WHERE id = ${runId} FOR UPDATE`;
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
      await aggregatePlayerScores(tx, gameId);
      await tx.evaluationRun.update({
        where: { id: runId },
        data: {
          status: 'complete',
          completedAt: new Date(),
          ...this.retainUndelivered(latest),
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
    // 人工采用只引用定义；原运行可能仍保留待上报正文，不能复制到没有交付任务的新运行。
    const { prompts: _prompts, ...frozen } = definition(original);
    const existing = await this.prisma.evaluationRun.findUnique({ where: { id: input.runId } });
    if (existing) {
      if (
        existing.gameId !== gameId ||
        !existing.selection ||
        !isDeepStrictEqual(existing.selection, json(selection)) ||
        !isDeepStrictEqual(existing.definition, json(frozen))
      )
        throw new Error('已存在的采用运行不能更换选择');
      await this.complete(gameId, input.runId);
      return;
    }
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
  ): EvaluatedResult {
    if (!frozen.projectId || !frozen.configurations)
      throw new Error('原评估尚未交付平台，不能采用外部评分');
    const quality = selectScore(scores, refs.quality),
      verdict = selectScore(scores, refs.verdict);
    for (const [score, config] of [
      [quality, frozen.configurations.quality],
      [verdict, frozen.configurations.verdict],
    ] as const) {
      if (!score) throw new Error('所选平台评分尚未完整可见，暂不能采用');
      if (
        score.projectId !== frozen.projectId ||
        score.configId !== config.id ||
        score.subject?.kind !== 'observation' ||
        score.subject.id !== target.observationId ||
        score.subject.traceId !== target.traceId
      )
        throw new Error('平台评分对象或定义不匹配');
    }
    if (quality!.dataType !== 'NUMERIC' || verdict!.dataType !== 'CATEGORICAL')
      throw new Error('平台评分维度类型不匹配');
    const result = {
      score: quality!.value as number,
      verdict: verdict!.value as string,
      reasoning: quality!.comment ?? '',
      modelName: `langfuse:${quality!.source}`,
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

  private async publishDefinition(run: EvaluationRun): Promise<void> {
    const frozen = definition(run);
    if (!frozen.prompts) return;
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
    ]);
  }

  private async bindDeliveryProject(run: EvaluationRun): Promise<EvaluationRun> {
    const frozen = definition(run);
    const currentDestination = this.platform.destination();
    if (
      frozen.destination &&
      (currentDestination.baseUrl !== frozen.destination.baseUrl ||
        (frozen.destination.publicKey &&
          currentDestination.publicKey !== frozen.destination.publicKey))
    )
      throw new Error('Langfuse 上报目标已改变，禁止交付到其他项目');
    const project = await this.platform.project();
    if (frozen.projectId && project.id !== frozen.projectId)
      throw new Error('Langfuse 凭证对应项目已改变，禁止交付冻结运行到其他项目');
    if (frozen.configurations) return run;
    const configurations = await this.platform.configurations();
    return this.changeRun(run.id, async (tx, current) => {
      const bound = definition(current);
      if (bound.projectId && bound.projectId !== project.id)
        throw new Error('Langfuse 项目绑定已改变，禁止覆盖原交付目标');
      if (bound.configurations) return current;
      return tx.evaluationRun.update({
        where: { id: run.id },
        data: {
          definition: json({ ...bound, projectId: project.id, configurations }),
        },
      });
    });
  }

  private retainUndelivered(run: EvaluationRun) {
    const remaining = Object.fromEntries(
      Object.entries(pending(run)).filter(
        ([id, entry]) => entry.result && !run.deliveredEventIds.includes(id),
      ),
    );
    const { prompts: _prompts, ...references } = definition(run) ?? {};
    return {
      pendingResults: json(remaining),
      deliveredEventIds: [],
      ...(run.definition
        ? { definition: json(Object.keys(remaining).length ? definition(run) : references) }
        : {}),
    };
  }

  private async supersedePending(tx: Prisma.TransactionClient, gameId: string): Promise<void> {
    // 等待正在保存或确认交付的结果，不能用旧快照覆盖刚落库的上报载荷。
    await tx.$executeRaw`SELECT id FROM evaluation_runs
      WHERE game_id = ${gameId}::uuid AND status NOT IN ('complete', 'superseded') FOR UPDATE`;
    const previous = await tx.evaluationRun.findMany({
      where: { gameId, status: { notIn: ['complete', 'superseded'] } },
    });
    for (const run of previous) {
      await tx.evaluationRun.update({
        where: { id: run.id },
        data: {
          status: 'superseded',
          ...this.retainUndelivered(run),
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

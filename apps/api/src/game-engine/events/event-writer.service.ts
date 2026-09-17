import { Injectable, Optional } from '@nestjs/common';
import { GameRecoveryService } from '@/game-recovery/game-recovery.service';
import { fenceExecution } from '@/game-recovery/execution-fence';
import { PrismaService } from '@/prisma/prisma.service';
import type { Prisma } from '@/generated/prisma/client';
import { recordEventDelivery } from '@/event-bus/record-event-delivery';
import type { PlayerDeathSnapshot } from '@/sse/sse-event.types';
import { VoteTurnBindingError, type VoteTurnCandidate } from '../ports/vote-turn.port';
import { isLegalVoteAction } from '../rules/ordinary-vote';
import {
  assertVoteEventMatches,
  persistVoteAttributions,
  voteAttributionHash,
} from './vote-attribution';
import {
  ACTION_TYPES,
  GAME_STATUSES,
  VISIBILITY_TYPES,
  PHASES,
  DEATH_CAUSES,
  type DeathCause,
  type SeerCheckResult,
} from '@ai-werewolf/shared';
import {
  type SubmissionScope,
  type CommittedEvent,
  SubmissionConflictError,
  normalizeSubmission,
  submissionHash,
  submissionKey,
  sortedUnique,
} from './submission-protocol';

type EventDraft = Pick<
  Prisma.EventUncheckedCreateInput,
  'day' | 'phase' | 'actionType' | 'visibility' | 'actorId' | 'targetIds' | 'content'
>;

/**
 * Event 写入服务
 *
 * 负责事件、状态与交付意图原子落库，独立消费者负责补送。
 */
@Injectable()
export class EventWriterService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly recovery?: GameRecoveryService,
  ) {}

  /** 夜间结算与全部死亡状态同事务；即使当夜终局也保留内部结算事实。 */
  async commitNightResolution(
    options: SubmissionScope & {
      day: number;
      deaths: Array<{ playerId: string; seatNo: number; cause: DeathCause }>;
    },
  ): Promise<CommittedEvent> {
    return this.createEventWithSequence(
      options,
      {
        day: options.day,
        phase: PHASES.NIGHT,
        actionType: ACTION_TYPES.NIGHT_RESOLVED,
        visibility: VISIBILITY_TYPES.SYSTEM,
        actorId: null,
        targetIds: options.deaths.map((death) => death.playerId),
        content: {
          deaths: options.deaths.toSorted((a, b) => a.playerId.localeCompare(b.playerId)),
        },
      },
      async (tx) => {
        for (const death of options.deaths) {
          await tx.player.update({
            where: { id: death.playerId, gameId: options.gameId },
            data: { deathDay: options.day, deathCause: death.cause },
          });
        }
      },
    );
  }

  /** 写入狼人自爆或提案事件 */
  async writeWolfDecisionEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      actionType: 'wolf_explode' | 'wolf_proposal';
      content: Prisma.InputJsonObject;
    },
  ): Promise<CommittedEvent> {
    return this.createEventWithSequence(options, {
      day: options.day,
      phase: options.actionType === 'wolf_explode' ? PHASES.DAY_ANNOUNCE : PHASES.NIGHT,
      actionType: options.actionType,
      visibility: VISIBILITY_TYPES.WOLF,
      actorId: options.actorId,
      targetIds: [],
      content: options.content,
    });
  }

  /** 写入预言家查验事件 */
  async writeSeerCheckEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      targetSeatNo: number;
      result: SeerCheckResult;
      thinking?: string;
    },
  ): Promise<CommittedEvent> {
    const { day, actorId, targetSeatNo, result, thinking } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.SEER_CHECK,
      visibility: VISIBILITY_TYPES.SEER,
      actorId,
      targetIds: [],
      content: {
        targetSeatNo,
        result,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入狼人刀人事件
   */
  async writeWolfKillEvent(
    options: SubmissionScope & {
      day: number;
      targetId?: string | null;
      targetSeatNo?: number;
      proposalEventIds?: string[];
    },
  ): Promise<CommittedEvent> {
    const { day, targetId, targetSeatNo } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WOLF_KILL,
      visibility: VISIBILITY_TYPES.WOLF_KILL, // 狼人 + 未用解药的女巫可见
      actorId: null, // 狼队集体决策，没有单一 actor
      targetIds: targetId ? [targetId] : [], // 空刀时为空数组
      content: {
        targetSeatNo,
        cause: 'night_kill',
        proposalEventIds: sortedUnique(options.proposalEventIds ?? [], '提案事件集合'),
      },
    });

    return event;
  }

  /**
   * 写入女巫解药事件
   */
  async writeWitchAntidoteEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      targetId: string;
      targetSeatNo: number;
      thinking?: string;
    },
  ): Promise<CommittedEvent> {
    const { day, actorId, targetId, targetSeatNo, thinking } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WITCH_SAVE,
      visibility: VISIBILITY_TYPES.WITCH,
      actorId,
      targetIds: targetSeatNo !== 0 ? [targetId] : [],
      content: {
        targetSeatNo,
        saved: targetSeatNo !== 0,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入女巫毒药事件
   */
  async writeWitchPoisonEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      targetId: string;
      targetSeatNo: number;
      thinking?: string;
    },
  ): Promise<CommittedEvent> {
    const { day, actorId, targetId, targetSeatNo, thinking } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.WITCH_POISON,
      visibility: VISIBILITY_TYPES.WITCH,
      actorId,
      targetIds: targetSeatNo !== 0 ? [targetId] : [],
      content: {
        targetSeatNo,
        used: targetSeatNo !== 0,
        cause: targetSeatNo !== 0 ? 'witch_poison' : null,
        thinking,
      },
    });

    return event;
  }

  /**
   * 写入死亡公告事件
   */
  async writeDeathAnnouncementEvent(
    options: SubmissionScope & {
      day: number;
      deaths: Array<{ playerId: string; seatNo: number; cause: string }>;
    },
  ): Promise<CommittedEvent> {
    const { day, deaths } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.DAY_ANNOUNCE,
      actionType: ACTION_TYPES.PLAYER_DIED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: deaths.map((d) => d.playerId),
      content: {
        deaths: deaths
          .toSorted((a, b) => a.playerId.localeCompare(b.playerId))
          .map((d) => ({
            seatNo: d.seatNo,
            cause: d.cause,
          })),
      },
    });

    return event;
  }

  /**
   * 写入平安夜事件
   */
  async writePeacefulNightEvent(
    options: SubmissionScope & {
      day: number;
    },
  ): Promise<CommittedEvent> {
    const { day } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.DAY_ANNOUNCE,
      actionType: ACTION_TYPES.PEACEFUL_NIGHT,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: {
        message: '昨晚是平安夜',
      },
    });

    return event;
  }

  /**
   * 写入玩家发言事件（白天公开发言）
   */
  async writePlayerSpeechEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      seatNo: number;
      content: string;
      thinking?: string; // AI 的推理过程
      sceneId?: string;
      sceneType?: 'speech' | 'last_words';
      /** 保留实际发言窗口与轮次，避免历史 PK、遗言被当成普通发言。 */
      turn?: { phase: string; round: number };
    },
  ): Promise<CommittedEvent> {
    const { day, actorId, seatNo, content, thinking } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SPEECH,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId,
      targetIds: [],
      content: {
        seatNo,
        speech: content,
        thinking,
        sceneId: options.sceneId,
        sceneType: options.sceneType,
        turn: options.turn,
      },
    });

    return event;
  }

  /**
   * 写入狼人夜间讨论事件（仅狼队可见）
   */
  async writeWolfDiscussionEvent(
    options: SubmissionScope & {
      day: number;
      actorId: string;
      seatNo: number;
      content: string;
      round: number; // 讨论轮次
      thinking?: string;
      sceneId?: string;
    },
  ): Promise<CommittedEvent> {
    const { day, actorId, seatNo, content, round, thinking } = options;

    const event = await this.createEventWithSequence(
      options,
      {
        day,
        phase: PHASES.NIGHT,
        actionType: ACTION_TYPES.SPEECH,
        visibility: VISIBILITY_TYPES.WOLF,
        actorId,
        targetIds: [],
        content: {
          seatNo,
          speech: content,
          round,
          thinking,
          sceneId: options.sceneId,
          sceneType: 'night_action',
        },
      },
      undefined,
      undefined,
      round,
    );

    return event;
  }

  /**
   * 原子提交放逐事件与玩家死亡状态
   */
  async commitExile(
    options: SubmissionScope & {
      day: number;
      targetId: string;
      targetSeatNo: number;
      voteCount: number;
    },
  ): Promise<CommittedEvent> {
    const { gameId, day, targetId, targetSeatNo, voteCount } = options;

    const event = await this.createEventWithSequence(
      options,
      {
        day,
        phase: PHASES.EXECUTE,
        actionType: ACTION_TYPES.PLAYER_EXECUTED,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [targetId],
        content: {
          targetSeatNo,
          voteCount,
          message: `${targetSeatNo}号位被放逐出局`,
        },
      },
      async (tx) => {
        await tx.player.update({
          where: { id: targetId, gameId },
          data: { deathDay: day, deathCause: DEATH_CAUSES.EXECUTION },
        });
      },
    );

    return event;
  }

  /**
   * 写入白痴翻牌事件
   */
  async writeIdiotRevealEvent(
    options: SubmissionScope & {
      day: number;
      playerId: string;
      seatNo: number;
    },
  ): Promise<CommittedEvent> {
    const { day, playerId, seatNo } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.EXECUTE,
      actionType: ACTION_TYPES.IDIOT_FLIP,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: playerId,
      targetIds: [],
      content: {
        seatNo,
        message: `${seatNo}号位白痴翻牌，免疫死亡`,
      },
    });

    return event;
  }

  /**
   * 写入警长决定发言顺序事件
   */
  async writeSheriffDecideOrderEvent(
    options: SubmissionScope & {
      day: number;
      sheriffId: string;
      sheriffSeatNo: number;
      direction: 'left' | 'right';
    },
  ): Promise<CommittedEvent> {
    const { day, sheriffId, sheriffSeatNo, direction } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SHERIFF_DECIDE_ORDER,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: sheriffId,
      targetIds: [],
      content: {
        sheriffSeatNo,
        direction,
        message: `警长${sheriffSeatNo}号位决定从${direction === 'left' ? '左手' : '右手'}开始发言（${direction === 'left' ? '逆时针' : '顺时针'}）`,
      },
    });

    return event;
  }

  /**
   * 写入发言顺序确定事件（无警长或自动计算）
   */
  async writeSpeechOrderDeterminedEvent(
    options: SubmissionScope & {
      day: number;
      speechOrder: number[];
      startSeatNo: number;
      direction: 'clockwise' | 'counterclockwise';
      reason: string;
    },
  ): Promise<CommittedEvent> {
    const { day, speechOrder, startSeatNo, direction, reason } = options;

    const event = await this.createEventWithSequence(options, {
      day,
      phase: PHASES.SPEECH,
      actionType: ACTION_TYPES.SPEECH_ORDER_DETERMINED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: {
        speechOrder,
        startSeatNo,
        direction,
        reason,
        message: `今天的发言顺序: ${speechOrder.join(' → ')}`,
      },
    });

    return event;
  }

  /** 游戏开始系统事件 */
  async writeGameStartEvent(
    params: SubmissionScope & {
      playerCount: number;
    },
  ): Promise<CommittedEvent> {
    return this.createEventWithSequence(params, {
      day: 0,
      phase: PHASES.SYSTEM,
      actionType: ACTION_TYPES.GAME_STARTED,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { playerCount: params.playerCount },
    });
  }

  /** 同时行动先收齐，再按参与者稳定排序提交；合法弃票仍产生 Event。 */
  async writeVoteBatch(
    options: SubmissionScope & {
      day: number;
      expectedActorIds: string[];
      turns?: VoteTurnCandidate[];
      votes: Array<{
        actorId: string;
        voterSeatNo: number;
        targetSeatNo: number;
        voteRound?: number;
        thinking?: string;
      }>;
    },
  ): Promise<CommittedEvent[]> {
    return this.createEventBatch(
      options,
      'vote',
      options.expectedActorIds,
      options.votes.map((vote) => ({
        day: options.day,
        phase: PHASES.VOTE,
        actionType: ACTION_TYPES.VOTE,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: vote.actorId,
        targetIds: [],
        content: {
          voteRound: vote.voteRound ?? 0,
          voterSeatNo: vote.voterSeatNo,
          targetSeatNo: vote.targetSeatNo,
          thinking: vote.thinking,
        },
      })),
      options.turns,
    );
  }

  /** 单狼提案和多狼投票采用同一批次协议。 */
  async writeWolfProposalBatch(
    options: SubmissionScope & {
      day: number;
      expectedActorIds: string[];
      proposals: Array<{
        actorId: string;
        seatNo: number;
        targetSeatNo: number;
        thinking?: string;
      }>;
    },
  ): Promise<CommittedEvent[]> {
    return this.createEventBatch(
      options,
      'wolf_proposal',
      options.expectedActorIds,
      options.proposals.map((proposal) => ({
        day: options.day,
        phase: PHASES.NIGHT,
        actionType: ACTION_TYPES.WOLF_PROPOSAL,
        visibility: VISIBILITY_TYPES.WOLF,
        actorId: proposal.actorId,
        targetIds: [],
        content: {
          seatNo: proposal.seatNo,
          targetSeatNo: proposal.targetSeatNo,
          thinking: proposal.thinking,
        },
      })),
    );
  }

  /** 终局状态与事件同事务；未指定结束时间时只在首次提交取时钟。 */
  async writeGameEndEvent(
    params: SubmissionScope & {
      winner: string;
      winnerFaction: string | null;
      totalDays: number;
      endedAt?: Date;
    },
  ): Promise<CommittedEvent> {
    const stateEffect = {
      winnerFaction: params.winnerFaction,
      totalDays: params.totalDays,
      endedAt: params.endedAt?.toISOString(),
    };
    return this.createEventWithSequence(
      params,
      {
        day: 0,
        phase: PHASES.SYSTEM,
        actionType: ACTION_TYPES.GAME_ENDED,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { winner: params.winner },
      },
      async (tx) => {
        await tx.game.update({
          where: { id: params.gameId },
          data: {
            status: GAME_STATUSES.FINISHED,
            winnerFaction: params.winnerFaction,
            totalDays: params.totalDays,
            endedAt: params.endedAt ?? new Date(),
          },
        });
      },
      stateEffect,
    );
  }

  /** 法官播报事件（公开）；可与该播报宣告的状态变更同事务提交。 */
  async writeJudgeEvent(
    params: SubmissionScope & {
      day: number;
      content: string;
      metadata?: Record<string, unknown>;
      death?: { playerId: string; cause: DeathCause };
    },
  ): Promise<CommittedEvent> {
    return this.createEventWithSequence(
      params,
      {
        day: params.day,
        phase: PHASES.JUDGE,
        actionType: ACTION_TYPES.JUDGE_ANNOUNCE,
        visibility: VISIBILITY_TYPES.PUBLIC,
        actorId: null,
        targetIds: [],
        content: { content: params.content, ...params.metadata } as Prisma.InputJsonValue,
      },
      params.death
        ? async (tx) => {
            await tx.player.update({
              where: { id: params.death!.playerId, gameId: params.gameId },
              data: { deathDay: params.day, deathCause: params.death!.cause },
            });
          }
        : undefined,
      params.death,
      0,
      params.death
        ? [
            {
              playerId: params.death.playerId,
              deathDay: params.day,
              deathCause: params.death.cause,
            },
          ]
        : [],
    );
  }

  /** 夜间法官引导事件 */
  async writeNightPromptEvent(
    params: SubmissionScope & {
      day: number;
      content: string;
      targetRole: string;
    },
  ): Promise<CommittedEvent> {
    return this.createEventWithSequence(params, {
      day: params.day,
      phase: PHASES.NIGHT,
      actionType: ACTION_TYPES.NIGHT_PROMPT,
      visibility: VISIBILITY_TYPES.PUBLIC,
      actorId: null,
      targetIds: [],
      content: { content: params.content, targetRole: params.targetRole },
    });
  }

  /** 业务去重在事务内完成，数据库行锁同时保护序号分配和批次仲裁。 */
  private async transaction<T>(
    scope: SubmissionScope,
    label: string,
    callback: (tx: Prisma.TransactionClient, status: string, saved?: T) => Promise<T>,
  ): Promise<T> {
    const run = async (tx: Prisma.TransactionClient, saved?: T) => {
      scope.signal?.throwIfAborted();
      const [game] = await tx.$queryRaw<
        Array<{ status: string }>
      >`SELECT status FROM games WHERE id = ${scope.gameId}::uuid FOR UPDATE`;
      if (!game) throw new Error('领域提交对应的对局不存在');
      const result = await callback(tx, game.status, saved);
      scope.signal?.throwIfAborted();
      return result;
    };
    if (this.recovery?.current && !scope.execution) {
      if (this.recovery.current.execution.gameId !== scope.gameId)
        throw new Error('领域提交与当前执行对局不符');
      return this.recovery.effect(label, (tx) => run(tx), {
        replay: (tx, saved) => run(tx, saved),
        allowFinished: true,
      });
    }
    // 显式执行身份由批次记录去重，图路径不再写旧效果完成日志。
    return this.prisma.$transaction(async (tx) => {
      if (scope.execution) await fenceExecution(tx, scope.execution, true);
      return run(tx);
    });
  }

  private draft(data: EventDraft): EventDraft {
    return normalizeSubmission({
      ...data,
      day: data.day ?? null,
      actorId: data.actorId ?? null,
      targetIds: sortedUnique((data.targetIds ?? []) as string[], '事件目标集合'),
    }) as EventDraft;
  }

  private assertWritable(status: string) {
    if (status !== GAME_STATUSES.RUNNING) throw new Error('当前对局状态不允许新增领域效果');
  }

  private async nextSequence(tx: Prisma.TransactionClient, gameId: string) {
    const previous = await tx.event.findFirst({
      where: { gameId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });
    return (previous?.sequence ?? 0) + 1;
  }

  private async createEventBatch(
    scope: SubmissionScope & { day: number },
    slot: string,
    expectedActorIds: string[],
    inputDrafts: EventDraft[],
    turns?: VoteTurnCandidate[],
  ): Promise<CommittedEvent[]> {
    const batchKey = submissionKey(scope, 'batch/' + slot);
    const expected = sortedUnique(expectedActorIds, '批次参与者');
    const drafts = inputDrafts
      .map((draft) => this.draft(draft))
      .toSorted((a, b) => a.actorId!.localeCompare(b.actorId!));
    const actual = sortedUnique(
      drafts.map((draft) => draft.actorId!),
      '批次结果',
    );
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error('批次结果未完整覆盖预期参与者');
    const turnByActor = new Map(turns?.map((turn) => [turn.reference.playerId, turn]));
    if (turns) {
      if (
        JSON.stringify(
          sortedUnique(
            turns.map((turn) => turn.reference.playerId),
            '投票产物',
          ),
        ) !== JSON.stringify(expected)
      )
        throw new VoteTurnBindingError('投票产物未完整覆盖批次');
      const cutoff = turns[0]?.reference.visibleThrough;
      for (const turn of turns) {
        const reference = turn.reference;
        const draft = drafts.find((entry) => entry.actorId === reference.playerId)!;
        assertVoteEventMatches(reference, {
          gameId: scope.gameId,
          actionType: draft.actionType,
          actorId: draft.actorId ?? null,
          day: draft.day ?? null,
          content: draft.content,
        });
        if (
          reference.phaseInstanceId !== scope.phaseInstanceId ||
          reference.round !== 0 ||
          !Number.isInteger(reference.visibleThrough) ||
          reference.visibleThrough < 0 ||
          reference.visibleThrough !== cutoff ||
          draft.content?.['thinking'] !== turn.reasoning ||
          !turn.attribution.snapshot ||
          submissionHash(turn.source) !==
            submissionHash(scope.sources?.[reference.playerId] ?? null)
        )
          throw new VoteTurnBindingError('投票产物的行动身份、输入截止或来源不一致');
      }
    }
    const effects = drafts.map((draft) => ({
      draft,
      effectKey: submissionKey(scope, slot, draft.actorId!),
      payloadHash: submissionHash({ gameId: scope.gameId, event: draft }),
    }));
    const outcomes = normalizeSubmission(
      effects.map((effect) => ({
        actorId: effect.draft.actorId!,
        effectKey: effect.effectKey,
        source: this.source(scope, effect.effectKey, effect.draft.actorId!),
        ...(turns
          ? { attributionHash: voteAttributionHash(turnByActor.get(effect.draft.actorId!)!) }
          : {}),
      })),
    )!;
    const payloadHash = submissionHash({
      gameId: scope.gameId,
      phaseInstanceId: scope.phaseInstanceId,
      day: scope.day,
      slot,
      expected,
      effects,
    });
    // 普通投票沿用原 label；内容和业务身份由独立记录仲裁，不依赖这个执行位置键。
    const label = `event-batch/${slot}/${inputDrafts[0]?.actorId ?? 'system'}`;
    return this.transaction(scope, label, async (tx, status, saved?: CommittedEvent[]) => {
      const previous = await tx.effectBatchCommit.findUnique({ where: { batchKey } });
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new SubmissionConflictError(batchKey);
        const events = await tx.event.findMany({
          where: { gameId: scope.gameId, id: { in: previous.eventIds } },
          orderBy: { sequence: 'asc' },
        });
        if (
          events.length !== previous.eventIds.length ||
          (saved &&
            JSON.stringify(saved.map((event) => event.id)) !== JSON.stringify(previous.eventIds))
        )
          throw new Error('批次记录与事件或恢复检查点不一致');
        if (turns) {
          const old = previous.outcomes as Array<{
            actorId: string;
            effectKey: string;
            source?: unknown;
            attributionHash?: string;
          }>;
          const current = outcomes as typeof old;
          if (
            old.length !== current.length ||
            old.some((outcome, index) => {
              const next = current[index];
              const event = events.find((entry) => entry.actorId === outcome.actorId);
              return (
                outcome.actorId !== next.actorId ||
                outcome.effectKey !== next.effectKey ||
                submissionHash(outcome.source ?? null) !== submissionHash(next.source ?? null) ||
                submissionHash(event?.source ?? null) !== submissionHash(next.source ?? null) ||
                (outcome.attributionHash !== undefined &&
                  outcome.attributionHash !== next.attributionHash)
              );
            })
          )
            throw new SubmissionConflictError(batchKey);
          if (old.some((outcome) => outcome.attributionHash === undefined)) {
            await persistVoteAttributions(tx, scope, events, turns, true);
            await tx.effectBatchCommit.update({ where: { batchKey }, data: { outcomes } });
          }
        }
        return events.map((event) => ({ ...event, replayed: true }));
      }
      if (saved) throw new Error('旧批次检查点缺少可验证的业务提交记录，拒绝重复写入');
      this.assertWritable(status);
      // 旧版本逐票检查点不命中新批次键，必须单独阻止不安全的部分续跑。
      if (this.recovery?.current) {
        const legacy = await tx.gameExecutionStep.findFirst({
          where: {
            gameId: scope.gameId,
            completed: true,
            OR: [
              { key: { startsWith: this.recovery.current.prefix + 'event/' + slot + '/' } },
              { key: { startsWith: this.recovery.current.prefix + 'event-batch/' + slot + '/' } },
            ],
          },
        });
        if (legacy) throw new Error('旧逐条提交检查点不能安全转换为批次，拒绝重复写入');
      }
      const players = await tx.player.findMany({
        where: { gameId: scope.gameId, ...(turns ? { deathDay: null } : { id: { in: expected } }) },
        select: { id: true, seatNo: true },
      });
      if (players.length !== expected.length) throw new Error('批次参与者不属于当前对局');
      if (
        turns &&
        turns.some(
          (turn) =>
            !isLegalVoteAction(
              turn.reference.action,
              players.map((player) => player.seatNo!),
            ),
        )
      )
        throw new VoteTurnBindingError('普通投票目标不合法');
      for (const effect of effects) {
        const content = effect.draft.content as Record<string, unknown>;
        if (
          players.find((player) => player.id === effect.draft.actorId)?.seatNo !==
          (content.voterSeatNo ?? content.seatNo)
        )
          throw new Error('批次玩家与座位不符');
      }
      // 不接纳已由其他提交路径写出的子效果，否则无法证明本批原子完成。
      const participantKeys = expected.map((actorId) => submissionKey(scope, slot, actorId));
      if (
        participantKeys.length &&
        (await tx.event.count({ where: { effectKey: { in: participantKeys } } }))
      )
        throw new SubmissionConflictError(batchKey);
      const first = await this.nextSequence(tx, scope.gameId);
      const events: CommittedEvent[] = [];
      for (const [index, effect] of effects.entries()) {
        const event = await tx.event.create({
          data: {
            ...effect.draft,
            gameId: scope.gameId,
            sequence: first + index,
            effectKey: effect.effectKey,
            payloadHash: effect.payloadHash,
            source: this.source(scope, effect.effectKey, effect.draft.actorId!),
          },
        });
        events.push({ ...event, replayed: false });
      }
      if (turns) await persistVoteAttributions(tx, scope, events, turns);
      await tx.effectBatchCommit.create({
        data: {
          batchKey,
          gameId: scope.gameId,
          payloadHash,
          outcomes,
          eventIds: events.map((event) => event.id),
        },
      });
      await recordEventDelivery(tx, events, batchKey);
      return events;
    });
  }

  private async createEventWithSequence(
    scope: SubmissionScope,
    input: EventDraft,
    updateState?: (tx: Prisma.TransactionClient) => Promise<void>,
    stateEffect?: unknown,
    ordinal = 0,
    playerDeaths: PlayerDeathSnapshot[] = [],
  ): Promise<CommittedEvent> {
    const data = this.draft(input);
    const effectKey = submissionKey(scope, data.actionType, data.actorId ?? 'system', ordinal);
    const payloadHash = submissionHash({ gameId: scope.gameId, event: data, stateEffect });
    const label =
      data.actionType === ACTION_TYPES.GAME_ENDED
        ? 'game-end'
        : `event/${data.actionType}/${data.actorId ?? 'system'}`;
    return this.transaction(scope, label, async (tx, status, saved?: CommittedEvent) => {
      const previous = await tx.event.findUnique({ where: { effectKey } });
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new SubmissionConflictError(effectKey);
        if (saved && saved.id !== previous.id) throw new Error('业务效果与恢复检查点不一致');
        return { ...previous, replayed: true };
      }
      if (saved) throw new Error('旧效果检查点缺少可验证的业务键，拒绝重复写入');
      if (
        await tx.effectBatchCommit.findUnique({
          where: { batchKey: submissionKey(scope, 'batch/' + data.actionType) },
        })
      )
        throw new SubmissionConflictError(effectKey);
      this.assertWritable(status);
      const event = await tx.event.create({
        data: {
          ...data,
          gameId: scope.gameId,
          sequence: await this.nextSequence(tx, scope.gameId),
          effectKey,
          payloadHash,
          source: this.source(scope, effectKey),
        },
      });
      await updateState?.(tx);
      await recordEventDelivery(tx, [event], undefined, playerDeaths);
      return { ...event, replayed: false };
    });
  }

  private source(
    scope: SubmissionScope,
    effectKey: string,
    actorId?: string,
  ): Prisma.InputJsonObject | undefined {
    const source = actorId ? scope.sources?.[actorId] : scope.source;
    if (!source) return undefined;
    if (
      source.actionKey !== effectKey ||
      !source.attemptId ||
      !source.traceId ||
      !source.outputObservationId ||
      !Number.isFinite(Date.parse(source.startedAt))
    )
      throw new Error('模型产物来源与领域行动不匹配');
    return { ...source };
  }
}

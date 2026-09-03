import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const repositoryRoot = resolve(__dirname, '../../../..');

// .env.local 优先于 .env（dotenv 默认不覆盖已存在的 process.env 变量）
loadEnv({ path: resolve(repositoryRoot, '.env.local') });
loadEnv({ path: resolve(repositoryRoot, '.env') });

// —— 度量输入类型 ——
interface FinishedGame {
  id: string;
  startedAt: Date;
  winnerFaction: string | null;
}

interface MisjudgmentRow {
  gameId: string;
  trustScore: number;
  suspicious: boolean;
  speakerFaction: string | null;
  judgerRole: string | null;
  judgerFaction: string | null;
  judgerName: string | null;
  judgerModel: string | null;
}

interface QualityRow {
  gameId: string;
  startedAt: Date;
  actionType: string;
  cnt: number;
  avgScore: number;
}

interface LiftHit {
  memoryId: string;
  actionType: string;
  rewardScore: number;
}

interface LessonRow {
  id: string;
  content: string;
}

interface KnowledgeUsageRow {
  eventId: string | null;
  actionType: string;
  rewardScore: number;
}

const SPEECH = 'speech';

/** 判定为好人 = trustScore>=50 且未标记可疑；否则判定为狼人。 */
function judgedGood(trustScore: number, suspicious: boolean): boolean {
  return trustScore >= 50 && !suspicious;
}

/** 摘要：lesson 正文截取前 60 字符，换行压缩成空格。 */
function lessonBrief(content: string): string {
  const flat = content.replace(/\s+/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function pct(num: number, den: number): string {
  return den === 0 ? '  -  ' : `${((num / den) * 100).toFixed(1).padStart(5)}%`;
}

/** 直接写 stdout：standalone 脚本输出报告，避免 Logger 前缀破坏表格对齐。 */
function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/** 按条数加权的均分（avgScore 已是按 actionType 聚合的均分）。 */
function avgQuality(rows: QualityRow[]): number {
  return (
    rows.reduce((s, r) => s + r.avgScore * r.cnt, 0) / (rows.reduce((s, r) => s + r.cnt, 0) || 1)
  );
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('缺少环境变量 DATABASE_URL');
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  await prisma.$connect();

  try {
    const games = await prisma.$queryRaw<FinishedGame[]>`
      SELECT id, started_at AS "startedAt", winner_faction AS "winnerFaction"
      FROM games
      WHERE status = 'finished'
      ORDER BY started_at
    `;

    if (games.length === 0) {
      print('没有已完成的对局，无法度量。');
      return;
    }

    // 误判行：判断者对发言者的信任判断 × 发言者真实阵营 × 判断者角色
    const misjudgments = await prisma.$queryRaw<MisjudgmentRow[]>`
      SELECT
        aj.game_id AS "gameId",
        aj.trust_score AS "trustScore",
        aj.suspicious AS suspicious,
        speaker.faction AS "speakerFaction",
        judger.role AS "judgerRole",
        judger.faction AS "judgerFaction",
        judger.display_name AS "judgerName",
        judger.model_name AS "judgerModel"
      FROM agent_judgments aj
      JOIN players speaker ON speaker.game_id = aj.game_id AND speaker.seat_no = aj.speaker_seat_no
      JOIN players judger  ON judger.game_id  = aj.game_id AND judger.agent_id  = aj.agent_id
      JOIN games g ON g.id = aj.game_id AND g.status = 'finished'
    `;

    // 决策/发言质量：按局 × 行为类型聚合
    const qualities = await prisma.$queryRaw<QualityRow[]>`
      SELECT
        dj.game_id AS "gameId",
        g.started_at AS "startedAt",
        dj.action_type AS "actionType",
        count(*)::int AS cnt,
        avg(dj.score) AS "avgScore"
      FROM decision_judgments dj
      JOIN games g ON g.id = dj.game_id AND g.status = 'finished'
      GROUP BY dj.game_id, g.started_at, dj.action_type
      ORDER BY g.started_at
    `;

    // lesson lift 原始数据：命中样本（trigger 匹配且有 reward）+ 各 actionType 基线
    const [liftHits, baselines, lessons, knowledgeHits] = await Promise.all([
      prisma.$queryRaw<LiftHit[]>`
        SELECT mu.memory_id AS "memoryId", mu.action_type AS "actionType", mu.reward_score AS "rewardScore"
        FROM memory_usages mu
        JOIN memories m ON m.id = mu.memory_id
        WHERE mu.trigger_matched = true
          AND mu.reward_score IS NOT NULL
          AND m.type = 'lesson'
          AND m.is_active = true
      `,
      prisma.$queryRaw<Array<{ actionType: string; avgScore: number }>>`
        SELECT action_type AS "actionType", avg(score) AS "avgScore"
        FROM decision_judgments
        GROUP BY action_type
      `,
      prisma.$queryRaw<LessonRow[]>`
        SELECT id, content
        FROM memories
        WHERE type = 'lesson' AND is_active = true
      `,
      // 已注入攻略的决策：以 rewardScore 非空代表该行为已被 judge 评分
      prisma.$queryRaw<KnowledgeUsageRow[]>`
        SELECT DISTINCT ku.event_id AS "eventId", ku.action_type AS "actionType", ku.reward_score AS "rewardScore"
        FROM knowledge_usages ku
        WHERE ku.event_id IS NOT NULL
          AND ku.reward_score IS NOT NULL
      `,
    ]);

    const baselineByAction = new Map(baselines.map((b) => [b.actionType, b.avgScore]));
    const allBaselines = [...baselineByAction.values()];
    const defaultBaseline =
      allBaselines.length > 0 ? allBaselines.reduce((a, b) => a + b, 0) / allBaselines.length : 50;

    // ============ 一、识人误判率（按判断者模型分层） ============
    print('========== 一、识人误判率（按判断者模型分层） ==========');
    const byModel = new Map<
      string,
      {
        name: string;
        roles: Set<string>;
        judged: number;
        trustedWolf: number;
        suspectedGood: number;
      }
    >();
    for (const row of misjudgments) {
      // 狼人开眼，其判断是策略性表态而非推理判断，不纳入「识人误判率」
      if (row.judgerFaction === 'werewolf') continue;
      if (row.speakerFaction !== 'villager' && row.speakerFaction !== 'werewolf') continue;
      const model = row.judgerModel ?? 'unknown';
      const stat = byModel.get(model) ?? {
        name: row.judgerName ?? 'unknown',
        roles: new Set<string>(),
        judged: 0,
        trustedWolf: 0,
        suspectedGood: 0,
      };
      stat.roles.add(row.judgerRole ?? 'unknown');
      stat.judged += 1;
      const good = judgedGood(row.trustScore, row.suspicious);
      if (good && row.speakerFaction === 'werewolf') stat.trustedWolf += 1;
      if (!good && row.speakerFaction === 'villager') stat.suspectedGood += 1;
      byModel.set(model, stat);
    }
    print(
      '判断者          模型                        角色分布  判断次数  误信狼  误疑好人  误判率',
    );
    let totalJudged = 0;
    let totalWrong = 0;
    for (const [model, s] of [...byModel.entries()].toSorted((a, b) => b[1].judged - a[1].judged)) {
      const wrong = s.trustedWolf + s.suspectedGood;
      totalJudged += s.judged;
      totalWrong += wrong;
      print(
        `${s.name.padEnd(14)}${model.padEnd(26)}${[...s.roles].toSorted().join('/').padEnd(10)}${String(
          s.judged,
        ).padStart(
          8,
        )}${String(s.trustedWolf).padStart(7)}${String(s.suspectedGood).padStart(9)}${pct(
          wrong,
          s.judged,
        ).padStart(9)}`,
      );
    }
    print(
      `${'合计'.padEnd(14)}${'-'.padEnd(26)}${'-'.padEnd(10)}${String(totalJudged).padStart(8)}${'-'.padStart(7)}${'-'.padStart(
        9,
      )}${pct(totalWrong, totalJudged).padStart(9)}`,
    );
    print('注：判断者模型 = players.model_name 开局快照；狼人开眼已排除。');
    print('');

    // ============ 二、决策/发言质量均分趋势（按局，时间序） ============
    print('========== 二、决策/发言质量均分趋势（按局，时间序） ==========');
    const byGame = new Map<
      string,
      { startedAt: Date; decision: { sum: number; n: number }; speech: { sum: number; n: number } }
    >();
    for (const row of qualities) {
      let entry = byGame.get(row.gameId);
      if (!entry) {
        entry = { startedAt: row.startedAt, decision: { sum: 0, n: 0 }, speech: { sum: 0, n: 0 } };
        byGame.set(row.gameId, entry);
      }
      const bucket = row.actionType === SPEECH ? entry.speech : entry.decision;
      bucket.sum += row.avgScore * row.cnt;
      bucket.n += row.cnt;
    }
    print('对局(短id)            决策均分(次)  发言均分(次)');
    for (const [gameId, e] of [...byGame.entries()].toSorted(
      (a, b) => a[1].startedAt.getTime() - b[1].startedAt.getTime(),
    )) {
      const dAvg = e.decision.n > 0 ? (e.decision.sum / e.decision.n).toFixed(1) : '  -  ';
      const sAvg = e.speech.n > 0 ? (e.speech.sum / e.speech.n).toFixed(1) : '  -  ';
      print(
        `${gameId.slice(0, 8).padEnd(22)}${dAvg.padStart(8)}(${String(e.decision.n).padStart(2)})${sAvg.padStart(9)}(${String(
          e.speech.n,
        ).padStart(2)})`,
      );
    }
    print('');

    // ============ 三、lesson lift 排行 ============
    print('========== 三、lesson lift 排行 ==========');
    const lessonById = new Map(lessons.map((l) => [l.id, l.content]));
    const hitsByMemory = new Map<string, LiftHit[]>();
    for (const h of liftHits) {
      const list = hitsByMemory.get(h.memoryId);
      if (list) list.push(h);
      else hitsByMemory.set(h.memoryId, [h]);
    }
    const ranked = [...hitsByMemory.entries()]
      .map(([memoryId, hits]) => {
        const lift =
          hits.reduce((sum, h) => {
            const baseline = baselineByAction.get(h.actionType) ?? defaultBaseline;
            return sum + (h.rewardScore - baseline);
          }, 0) / hits.length;
        return { memoryId, lift, n: hits.length };
      })
      .toSorted((a, b) => b.lift - a.lift);

    const printRank = (list: typeof ranked) => {
      for (const r of list) {
        const brief = lessonBrief(lessonById.get(r.memoryId) ?? '（内容缺失）');
        print(`${r.lift.toFixed(1).padStart(6)}  n=${String(r.n).padStart(2)}  ${brief}`);
      }
    };
    if (ranked.length === 0) {
      print('暂无带 reward 的命中样本。');
    } else {
      print('— Top 10（lift 最高）—');
      printRank(ranked.slice(0, 10));
      if (ranked.length > 10) {
        print('— Bottom 10（lift 最低）—');
        printRank(ranked.slice(-10).toReversed());
      }
    }
    print('');

    // ============ 四、冷启动 vs 当前对比 ============
    print('========== 四、冷启动 vs 当前对比 ==========');
    const half = Math.floor(games.length / 2);
    const coldGames = new Set(games.slice(0, half).map((g) => g.id));
    const warmGames = new Set(games.slice(half).map((g) => g.id));
    const splitQuality = (ids: Set<string>) => {
      const q = qualities.filter((r) => ids.has(r.gameId));
      const decision = q.filter((r) => r.actionType !== SPEECH);
      const speech = q.filter((r) => r.actionType === SPEECH);
      return {
        decisionAvg: avgQuality(decision),
        speechAvg: avgQuality(speech),
        decisionN: decision.reduce((s, r) => s + r.cnt, 0),
        speechN: speech.reduce((s, r) => s + r.cnt, 0),
      };
    };
    const splitMisjudge = (ids: Set<string>) => {
      const rows = misjudgments.filter((r) => ids.has(r.gameId));
      let judged = 0;
      let wrong = 0;
      for (const row of rows) {
        // 狼人开眼，其判断是策略性表态，不纳入「识人误判率」
        if (row.judgerFaction === 'werewolf') continue;
        if (row.speakerFaction !== 'villager' && row.speakerFaction !== 'werewolf') continue;
        judged += 1;
        const good = judgedGood(row.trustScore, row.suspicious);
        if (
          (good && row.speakerFaction === 'werewolf') ||
          (!good && row.speakerFaction === 'villager')
        ) {
          wrong += 1;
        }
      }
      return { judged, wrong };
    };
    const coldQ = splitQuality(coldGames);
    const warmQ = splitQuality(warmGames);
    const coldM = splitMisjudge(coldGames);
    const warmM = splitMisjudge(warmGames);
    print(`                冷启动(前${half}局)    当前(后${games.length - half}局)`);
    print(
      `决策质量均分   ${coldQ.decisionAvg.toFixed(1).padStart(8)}(n=${String(coldQ.decisionN).padStart(2)})${warmQ.decisionAvg
        .toFixed(1)
        .padStart(12)}(n=${String(warmQ.decisionN).padStart(2)})`,
    );
    print(
      `发言质量均分   ${coldQ.speechAvg.toFixed(1).padStart(8)}(n=${String(coldQ.speechN).padStart(2)})${warmQ.speechAvg
        .toFixed(1)
        .padStart(12)}(n=${String(warmQ.speechN).padStart(2)})`,
    );
    print(
      `识人误判率     ${pct(coldM.wrong, coldM.judged).padStart(8)}(n=${String(coldM.judged).padStart(2)})${pct(
        warmM.wrong,
        warmM.judged,
      ).padStart(12)}(n=${String(warmM.judged).padStart(2)})`,
    );
    print('');

    // ============ 五、攻略注入 vs 未注入 质量对比 ============
    print('========== 五、攻略注入 vs 未注入 质量对比 ==========');
    // knowledge_usages 记录了注入过攻略的决策事件；对比这些事件 vs 其余 judge 评分事件的分数
    const scoredEvents = await prisma.$queryRaw<
      Array<{ eventId: string; score: number; actionType: string }>
    >`
      SELECT dj.event_id AS "eventId", dj.score AS score, dj.action_type AS "actionType"
      FROM decision_judgments dj
      WHERE dj.score IS NOT NULL
    `;
    const injectedEventIds = new Set(
      knowledgeHits.map((h) => h.eventId).filter((e): e is string => !!e),
    );
    let injectedSum = 0;
    let injectedN = 0;
    let nonInjectedSum = 0;
    let nonInjectedN = 0;
    for (const row of scoredEvents) {
      if (injectedEventIds.has(row.eventId)) {
        injectedSum += row.score;
        injectedN += 1;
      } else {
        nonInjectedSum += row.score;
        nonInjectedN += 1;
      }
    }
    const injectedAvg = injectedN > 0 ? (injectedSum / injectedN).toFixed(1) : '  -  ';
    const nonInjectedAvg = nonInjectedN > 0 ? (nonInjectedSum / nonInjectedN).toFixed(1) : '  -  ';
    print(`                注入(被评分决策)   未注入(其余决策)`);
    print(
      `决策质量均分   ${injectedAvg.padStart(10)}(n=${String(injectedN).padStart(2)})${nonInjectedAvg.padStart(14)}(n=${String(
        nonInjectedN,
      ).padStart(2)})`,
    );
    if (injectedN === 0) {
      print('暂无已注入攻略且被评分的决策（需先用 judge 跑出分数）。');
    }
    print('');

    // ============ 辅助：阵营胜率 ============
    const winByFaction = new Map<string, number>();
    for (const g of games) {
      const f = g.winnerFaction ?? 'unknown';
      winByFaction.set(f, (winByFaction.get(f) ?? 0) + 1);
    }
    print(
      `阵营胜率（共 ${games.length} 局）：${[...winByFaction.entries()]
        .map(([f, n]) => `${f} ${n}`)
        .join('，')}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

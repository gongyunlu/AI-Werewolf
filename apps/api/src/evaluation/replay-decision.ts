import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ConfigService } from '@nestjs/config';
import { validateEnv, type Env } from '../config/env.validation';
import { ModelCallService } from '../llm/model-call.service';
import { PlayerTurnService } from '../player-turn/player-turn.service';
import { replayDecision, type DecisionReplaySnapshot } from '../player-turn/decision-replay';
import { PromptService } from '../observability/prompt.service';
import { LangfuseService } from '../observability/langfuse.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { knowledgeRejection, type KnowledgeSituation } from '../knowledge/knowledge-policy';
import type { KnowledgeHit } from '../knowledge/knowledge.service';

const root = resolve(__dirname, '../../../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });
const option = (key: string) =>
  process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);

interface ReplaySnapshot extends DecisionReplaySnapshot {
  version: 1;
  baseSystemPrompt: string;
  situation: KnowledgeSituation;
  knowledgeHits: KnowledgeHit[];
  injectionEnabled: boolean;
}

async function main() {
  const eventId = option('event');
  const oracleIds = option('oracle')?.split(',').filter(Boolean) ?? [];
  if (!eventId)
    throw new Error(
      '用法：--event=<id> [--oracle=<适用攻略ID>] [--reflection-rounds=<次数>] [--out=<文件>] [--run]',
    );
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  let langfuse: LangfuseService | undefined;
  try {
    const context = await prisma.decisionContext.findUnique({ where: { eventId } });
    if (!context)
      throw new Error(
        'This historical event has no immutable input snapshot; cannot reconstruct a controlled replay.',
      );
    const snapshot = context.snapshot as unknown as ReplaySnapshot;
    if (snapshot.version !== 1 || !snapshot.schema)
      throw new Error('Not a supported structured decision snapshot');
    const reflectionOverride = option('reflection-rounds');
    if (reflectionOverride !== undefined) snapshot.reflectionMaxRounds = Number(reflectionOverride);
    if (process.argv.includes('--run') && snapshot.reflectionMaxRounds === undefined)
      throw new Error(
        '历史快照未记录反思配置；请显式提供 --reflection-rounds=<次数> 进行当前回合路径诊断',
      );
    if (oracleIds.length && !snapshot.injectionEnabled)
      throw new Error(
        'Select an ON event: OFF events do not contain an automatic retrieval result for B.',
      );
    let variants = [
      {
        arm: 'original',
        system: snapshot.systemPrompt,
        chunkIds: snapshot.knowledgeHits.map((h) => h.id),
      },
    ];
    if (oracleIds.length) {
      const oracle = await prisma.knowledgeChunk.findMany({ where: { id: { in: oracleIds } } });
      if (oracle.length !== new Set(oracleIds).size) throw new Error('Oracle chunk missing');
      for (const chunk of oracle) {
        const rejection = knowledgeRejection(chunk.applicability, snapshot.situation);
        if (
          rejection ||
          (chunk.role !== 'any' && chunk.role !== snapshot.role) ||
          (chunk.scenario !== 'any' && chunk.scenario !== snapshot.scenario)
        )
          throw new Error(`Oracle ${chunk.id} is not applicable: ${rejection ?? 'role/scenario'}`);
      }
      const knowledge = oracle
        .map(
          (hit) =>
            `### ${hit.articleTitle}【${hit.role === 'any' ? '通用' : hit.role}】\n场景：${hit.scenario}\n触发：${hit.trigger}\n行动：${hit.action}`,
        )
        .join('\n\n');
      // 用原骨架中的攻略变量替换，保证 C 的位置与 B 完全一致。
      const skeleton = snapshot.prompts[PROMPT_NAMES.agentSystemPrompt]?.text;
      const marker = skeleton?.match(/([^\n]*\n[ \t]*)\{\{\s*knowledge\s*\}\}/)?.[1];
      if (!marker || !snapshot.baseSystemPrompt.includes(`${marker}暂无`))
        throw new Error('Cannot identify the frozen knowledge slot safely');
      variants = [
        { arm: 'A', system: snapshot.baseSystemPrompt, chunkIds: [] as string[] },
        {
          arm: 'B',
          system: snapshot.systemPrompt,
          chunkIds: snapshot.knowledgeHits.map((h) => h.id),
        },
        {
          arm: 'C',
          system: snapshot.baseSystemPrompt.replace(`${marker}暂无`, `${marker}${knowledge}`),
          chunkIds: oracle.map((c) => c.id),
        },
      ];
    }
    const artifact: Record<string, unknown> = {
      id: randomUUID(),
      eventId,
      gameId: context.gameId,
      createdAt: new Date().toISOString(),
      mode: process.argv.includes('--run') ? 'run' : 'prepare',
      reflectionConfigurationSource:
        reflectionOverride === undefined ? 'snapshot' : 'explicit_override',
      snapshot,
      oracleIds,
      variants,
    };
    const out = resolve(option('out') ?? `replay-${eventId}-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify(artifact, null, 2), { flag: 'wx' });
    if (process.argv.includes('--run')) {
      const results: Array<{
        arm: string;
        blindId: string;
        reasoning: string;
        decision: unknown;
        durationMs: number;
        reflection: unknown;
      }> = [];
      const config = new ConfigService<Env, true>(validateEnv(process.env));
      langfuse = new LangfuseService(config);
      const turns = new PlayerTurnService(
        config,
        new ModelCallService(config),
        new PromptService(config),
        langfuse,
      );
      const signal = AbortSignal.timeout(config.get('GAME_MAX_DURATION_MS', { infer: true })!);
      // 随机执行顺序，结果同时保存匿名编号供人工盲审；不改线上评分。
      const order = [...variants];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const variant of order) {
        const start = Date.now();
        const { reasoning, decision, reflection } = await replayDecision(
          turns,
          { ...snapshot, systemPrompt: variant.system },
          { gameId: String(artifact.id), playerId: context.playerId },
          signal,
        );
        results.push({
          arm: variant.arm,
          blindId: randomUUID(),
          reasoning,
          decision,
          durationMs: Date.now() - start,
          reflection,
        });
        artifact.results = results;
        writeFileSync(out, JSON.stringify(artifact, null, 2));
      }
      writeFileSync(
        `${out}.blind.json`,
        JSON.stringify(
          {
            eventId,
            evidence: snapshot.baseSystemPrompt,
            schema: snapshot.schema,
            results: results.map(({ blindId, decision, reasoning }) => ({
              blindId,
              decision,
              reasoning,
            })),
          },
          null,
          2,
        ),
        { flag: 'wx' },
      );
    }
    process.stdout.write(
      JSON.stringify({
        out,
        mode: artifact.mode,
        variants: variants.map((v) => ({ arm: v.arm, chunkIds: v.chunkIds })),
      }),
    );
  } finally {
    await langfuse?.onModuleDestroy();
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

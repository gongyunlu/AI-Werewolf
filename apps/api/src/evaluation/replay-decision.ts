import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ChatOpenAI } from '@langchain/openai';
import { SystemMessage, HumanMessage, AIMessage } from '@langchain/core/messages';
import { PROMPT_NAMES, renderTemplate } from '../observability/prompt-templates';
import { resolveStructuredOutputMethod } from '../observability/structured-output-method';
import { knowledgeRejection, type KnowledgeSituation } from '../knowledge/knowledge-policy';
import type { KnowledgeHit } from '../knowledge/knowledge.service';
import type { FrozenPrompts } from './experiment-snapshot';

const root = resolve(__dirname, '../../../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });
const option = (key: string) =>
  process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);

interface ReplaySnapshot {
  version: 1;
  decisionMode?: 'joint';
  outputSchema?: Record<string, unknown>;
  baseSystemPrompt: string;
  systemPrompt: string;
  modelName: string;
  role: string;
  scenario: string;
  situation: KnowledgeSituation;
  knowledgeHits: KnowledgeHit[];
  injectionEnabled: boolean;
  schema: Record<string, unknown>;
  prompts: FrozenPrompts;
  reasoningHistory?: Array<{ type: string; content: string }>;
}

async function main() {
  const eventId = option('event');
  const oracleIds = option('oracle')?.split(',').filter(Boolean) ?? [];
  if (!eventId || !oracleIds.length)
    throw new Error('Use --event=<id> --oracle=<applicable chunk ids> [--out=<file>] [--run]');
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    const context = await prisma.decisionContext.findUnique({ where: { eventId } });
    if (!context)
      throw new Error(
        'This historical event has no immutable input snapshot; cannot reconstruct a controlled replay.',
      );
    const snapshot = context.snapshot as unknown as ReplaySnapshot;
    if (snapshot.version !== 1 || !snapshot.schema)
      throw new Error('Not a supported structured decision snapshot');
    if (!snapshot.injectionEnabled)
      throw new Error(
        'Select an ON event: OFF events do not contain an automatic retrieval result for B.',
      );
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
    const variants = [
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
    const artifact: Record<string, unknown> = {
      id: randomUUID(),
      eventId,
      gameId: context.gameId,
      createdAt: new Date().toISOString(),
      mode: process.argv.includes('--run') ? 'run' : 'prepare',
      snapshot,
      oracle,
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
      }> = [];
      const render = (name: string, variables?: Record<string, string>) => {
        const template = snapshot.prompts[name];
        if (!template) throw new Error(`Missing frozen prompt ${name}`);
        return renderTemplate(template.text, variables);
      };
      const history = (snapshot.reasoningHistory ?? []).map((m) =>
        m.type === 'ai' ? new AIMessage(m.content) : new HumanMessage(m.content),
      );
      // 随机执行顺序，结果同时保存匿名编号供人工盲审；不改线上评分。
      const order = [...variants];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (const variant of order) {
        const start = Date.now();
        const options = {
          apiKey: process.env.ARK_API_KEY,
          model: snapshot.modelName,
          configuration: { baseURL: process.env.ARK_BASE_URL },
        };
        let reasoning: string;
        let decision: unknown;
        if (snapshot.decisionMode === 'joint') {
          if (!snapshot.outputSchema) throw new Error('Joint decision schema missing');
          const output = await new ChatOpenAI(options)
            .withStructuredOutput(snapshot.outputSchema, {
              method: resolveStructuredOutputMethod(snapshot.modelName),
            })
            .invoke([
              new SystemMessage(
                render(PROMPT_NAMES.agentActionSystem, { systemPrompt: variant.system }),
              ),
              ...history,
              new HumanMessage('请提交本次的 reasoning 和 decision，理由与最终动作必须一致。'),
            ]);
          reasoning = String(output.reasoning);
          decision = output.decision;
        } else {
          const reasoningResult = await new ChatOpenAI({
            ...options,
            modelKwargs: { thinking: { type: 'enabled' }, reasoning_effort: 'medium' },
          }).invoke([
            new SystemMessage(variant.system),
            ...history,
            new HumanMessage(render(PROMPT_NAMES.agentReasoning)),
          ]);
          reasoning =
            typeof reasoningResult.additional_kwargs.reasoning_content === 'string'
              ? reasoningResult.additional_kwargs.reasoning_content
              : String(reasoningResult.content);
          decision = await new ChatOpenAI(options)
            .withStructuredOutput(snapshot.schema, {
              method: resolveStructuredOutputMethod(snapshot.modelName),
            })
            .invoke([
              new SystemMessage(
                render(PROMPT_NAMES.agentDecisionSystem, { systemPrompt: variant.system }),
              ),
              new HumanMessage(render(PROMPT_NAMES.agentDecisionUser, { reasoning })),
            ]);
        }
        results.push({
          arm: variant.arm,
          blindId: randomUUID(),
          reasoning,
          decision,
          durationMs: Date.now() - start,
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
    await prisma.$disconnect();
  }
}

void main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

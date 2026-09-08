import { lessonApplies } from '../memory/lesson-applicability';
import type { Prisma } from '../generated/prisma/client';
import type { ActiveMemory, SimilarMemory } from '../memory/memory.service';
import { computeLessonCandidateScore } from '../memory/lesson-rank';
import { ExperimentInvalidError } from './experiment-integrity';

export type FrozenPrompts = Record<string, { text: string; version: number | null }>;
export type FrozenMemory = ActiveMemory & {
  agentId: string;
  label: string;
  createdAt: string;
  metadata: Record<string, unknown>;
  embedding: number[] | null;
  rank: number;
};
export interface ExperimentSnapshot {
  version: 1;
  experimentId: string;
  pairId: string;
  arm: 'on' | 'off';
  capturedAt: string;
  invalid?: { reason: string; at: string };
  memories: FrozenMemory[];
  globalPatterns: Array<{ title: string; content: string }>;
  knowledgeChunkIds: string[];
  prompts: FrozenPrompts;
  skills: Record<string, string>;
  embeddingModel: string;
  judgeModel: string;
  auxiliaryModel: string;
  roleContexts: Record<string, string>;
  assignments: Array<{
    agentId: string;
    seatNo: number;
    role: string;
    faction: string;
    modelName: string;
    memoryLabel: string;
  }>;
}

export function readExperiment(
  value: Prisma.JsonValue | undefined,
): ExperimentSnapshot | undefined {
  if (value == null) return undefined;
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    !Array.isArray(value.memories) ||
    (value.arm !== 'on' && value.arm !== 'off')
  ) {
    throw new ExperimentInvalidError('对局实验快照格式不受支持');
  }
  return value as unknown as ExperimentSnapshot;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('冻结向量维度不一致');
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] ** 2;
    bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function retrieveFrozenMemories(
  memories: FrozenMemory[],
  input: {
    agentId: string;
    label: string;
    opponentAgentIds: string[];
    role: string | null;
    scenario: string;
    queryVector: number[];
    facts?: string[];
  },
): { active: ActiveMemory[]; lessons: SimilarMemory[]; playerModels: ActiveMemory[] } {
  const own = memories.filter((m) => m.agentId === input.agentId && m.label === input.label);
  const active = own
    .filter((m) => m.type === 'persona' || m.type === 'strategy')
    .toSorted((a, b) => b.importance - a.importance || a.createdAt.localeCompare(b.createdAt))
    .slice(0, 20);
  const seenTargets = new Set<string>();
  const playerModels = own
    .filter(
      (m) =>
        m.type === 'player_model' &&
        input.opponentAgentIds.includes(String(m.metadata.targetAgentId)),
    )
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
    .filter((m) => {
      const id = String(m.metadata.targetAgentId);
      if (seenTargets.has(id)) return false;
      seenTargets.add(id);
      return true;
    });
  const lessons = own
    .filter(
      (m) =>
        m.type === 'lesson' &&
        lessonApplies(m.metadata, input.facts ?? []) &&
        m.embedding &&
        (!input.role || m.metadata.role === input.role || m.metadata.role === 'any') &&
        (m.metadata.scenario === input.scenario || m.metadata.scenario === 'any'),
    )
    .map((m) =>
      Object.assign({}, m, { similarity: cosineSimilarity(input.queryVector, m.embedding!) }),
    )
    .toSorted((a, b) => b.similarity - a.similarity)
    .slice(0, 20)
    .filter((m) => m.similarity > 0)
    .toSorted(
      (a, b) =>
        computeLessonCandidateScore(b.similarity, b.rank) -
        computeLessonCandidateScore(a.similarity, a.rank),
    )
    .slice(0, 3);
  return { active, lessons, playerModels };
}

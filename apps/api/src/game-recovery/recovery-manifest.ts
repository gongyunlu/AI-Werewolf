import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

const CONFIG_KEYS = [
  'ARK_BASE_URL',
  'ARK_DEFAULT_MODEL',
  'ARK_EMBEDDING_MODEL',
  'KNOWLEDGE_INJECTION',
  'GAME_MAX_DAYS',
  'GAME_MAX_DURATION_MS',
  'GAME_MAX_MODEL_FALLBACKS',
  'TURN_REFLECTION_MAX_ROUNDS',
  'LLM_CALL_TIMEOUT_MS',
  'LLM_FIRST_CHUNK_TIMEOUT_MS',
  'LLM_STREAM_IDLE_TIMEOUT_MS',
  'LLM_STREAM_MAX_DURATION_MS',
  'LLM_CIRCUIT_MIN_SAMPLES',
  'LLM_CIRCUIT_COOLDOWN_MS',
  'SKILLS_DIR',
] as const;

/** 密钥不进入检查点；代码、规则和影响玩家调用的配置变化时拒绝混用旧执行记录。 */
export function recoveryFingerprint(config: ConfigService<Env, true>, ruleset: unknown): string {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify({
      version: 2,
      node: process.version,
      ruleset,
      config: Object.fromEntries(CONFIG_KEYS.map((key) => [key, config.get(key)])),
    }),
  );
  const root = join(__dirname, '..');
  const addFile = (path: string) => {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update(readFileSync(path));
  };
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing') visit(path);
      } else if (
        /\.(ts|js|cjs|mjs|md|json)$/.test(entry.name) &&
        !/\.(spec|test|d)\.(ts|js)$/.test(entry.name)
      )
        addFile(path);
    }
  };
  // 覆盖实际运行目录，避免每次新增上下文或持久化模块都要维护一份目录白名单。
  visit(root);
  const skillsDir = config.get('SKILLS_DIR');
  if (skillsDir) visit(resolve(skillsDir));
  addFile(require.resolve('@ai-werewolf/shared'));
  const workspace = resolve(root, '../../..');
  for (const file of [
    'pnpm-lock.yaml',
    'package.json',
    'apps/api/package.json',
    'packages/shared/package.json',
  ])
    addFile(join(workspace, file));
  return hash.digest('hex');
}

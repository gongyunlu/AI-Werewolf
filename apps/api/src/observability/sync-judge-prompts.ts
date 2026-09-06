import { Logger } from '@nestjs/common';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { Langfuse } from 'langfuse-langchain';
import { FALLBACK_TEMPLATES, PROMPT_NAMES } from './prompt-templates';

const repositoryRoot = resolve(__dirname, '../../../..');

const logger = new Logger('SyncJudgePrompts');

function print(line = ''): void {
  process.stdout.write(`${line}\n`);
}

// .env.local 优先于 .env（dotenv 默认不覆盖已存在的 process.env 变量）
loadEnv({ path: resolve(repositoryRoot, '.env.local') });
loadEnv({ path: resolve(repositoryRoot, '.env') });

/**
 * 把本地 fallback 的 judge prompt 文本同步到 Langfuse 的 production 标签。
 *
 * 只覆盖 judge 评分链路的 prompt（初评与反思 system）；其余 prompt 可能在线上被手调过，
 * 全量推送会误覆盖，故不纳入。
 *
 * createPrompt 会为同一 name 创建新 version 并把 production 标签移过去（旧 version
 * 自动失去 production 标签），因此重复执行是幂等的「更新到最新文本」。
 */
const TARGETS = [
  { name: PROMPT_NAMES.judgeSystem, prompt: FALLBACK_TEMPLATES[PROMPT_NAMES.judgeSystem] },
  {
    name: PROMPT_NAMES.judgeSpeechSystem,
    prompt: FALLBACK_TEMPLATES[PROMPT_NAMES.judgeSpeechSystem],
  },
  {
    name: PROMPT_NAMES.judgeRefineSystem,
    prompt: FALLBACK_TEMPLATES[PROMPT_NAMES.judgeRefineSystem],
  },
  {
    name: PROMPT_NAMES.judgeSpeechRefineSystem,
    prompt: FALLBACK_TEMPLATES[PROMPT_NAMES.judgeSpeechRefineSystem],
  },
] as const;

async function main(): Promise<void> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_HOST;
  if (!publicKey || !secretKey || !baseUrl) {
    throw new Error('缺少 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_HOST');
  }

  const langfuse = new Langfuse({ publicKey, secretKey, baseUrl });

  try {
    for (const { name, prompt } of TARGETS) {
      const created = await langfuse.createPrompt({
        name,
        type: 'text',
        prompt,
        labels: ['production'],
        config: {},
      });
      print(`已同步 ${name} → version ${created.version}（labels: ${created.labels.join(', ')}）`);
    }
  } finally {
    await langfuse.shutdownAsync();
  }
}

void main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

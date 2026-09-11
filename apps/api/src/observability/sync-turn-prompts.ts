import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { writeFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Langfuse } from 'langfuse-langchain';
import {
  FALLBACK_TEMPLATES,
  PROMPT_NAMES,
  REQUIRED_PROMPT_VARIABLES,
  extractPromptVariables,
} from './prompt-templates';

const root = resolve(__dirname, '../../../..');
loadEnv({ path: resolve(root, '.env.local'), quiet: true });
loadEnv({ path: resolve(root, '.env'), quiet: true });
const targets = [
  PROMPT_NAMES.agentSystemPrompt,
  PROMPT_NAMES.agentTurnReflect,
  PROMPT_NAMES.agentTurnRevise,
];
function print(value: unknown) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function main() {
  const apply = process.argv.includes('--apply');
  const pull = process.argv.includes('--pull');
  if (apply && pull) throw new Error('--apply 与 --pull 不能同时使用');
  const {
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
    LANGFUSE_HOST: baseUrl,
  } = process.env;
  if (!publicKey || !secretKey || !baseUrl) throw new Error('缺少 Langfuse 连接配置');
  const client = new Langfuse({ publicKey, secretKey, baseUrl });
  const released: Record<string, { text: string; version: number; sha256: string }> = {};
  try {
    for (const name of targets) {
      let current;
      try {
        current = await client.getPrompt(name, undefined, {
          label: 'production',
          cacheTtlSeconds: 0,
        });
      } catch (error) {
        const status =
          (error as { statusCode?: number; status?: number }).statusCode ??
          (error as { status?: number }).status;
        const missing =
          error instanceof Error &&
          error.message === "Prompt not found: '" + name + "' with label 'production'";
        if (status !== 404 && !missing) throw error;
      }
      const text = pull ? current?.prompt : FALLBACK_TEMPLATES[name];
      if (typeof text !== 'string') throw new Error('缺少文本 Prompt: ' + name);
      const variables = new Set(extractPromptVariables(text));
      if (REQUIRED_PROMPT_VARIABLES[name].some((v) => !variables.has(v)))
        throw new Error('Prompt 缺少上下文变量: ' + name);
      const changed = current?.prompt !== text;
      print({
        name,
        currentVersion: current?.version ?? null,
        changed,
        sha256: hash(text),
      });
      if (apply && changed)
        current = await client.createPrompt({
          name,
          type: 'text',
          prompt: text,
          labels: ['production'],
          config: { purpose: 'player-turn', sha256: hash(text) },
        });
      if (apply || pull) {
        const verified = await client.getPrompt(name, undefined, {
          label: 'production',
          cacheTtlSeconds: 0,
        });
        if (verified.prompt !== text) throw new Error('发布期间版本改变，停止导出: ' + name);
        released[name] = { text, version: verified.version, sha256: hash(text) };
        print({ name, verifiedVersion: verified.version });
      }
    }
    if (apply || pull) {
      const destination = resolve(__dirname, 'turn-prompt-release.json');
      const temporary = destination + '.tmp';
      writeFileSync(
        temporary,
        JSON.stringify({ exportedAt: new Date().toISOString(), prompts: released }, null, 2) + '\n',
      );
      renameSync(temporary, destination);
    }
  } finally {
    await client.shutdownAsync();
  }
}
void main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});

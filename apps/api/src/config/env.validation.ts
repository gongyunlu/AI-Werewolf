import { z } from 'zod';

/** 把「变量存在但值为空」视作未配置，避免可选项被空字符串卡住校验 */
const emptyToUndefined = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  ARK_API_KEY: z.string().min(1),
  ARK_BASE_URL: z.url(),
  ARK_DEFAULT_MODEL: z.string().min(1),
  GAME_WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(1),
  SKILLS_DIR: z.string().optional(),
  PROMPTS_DIR: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // LangFuse 追踪：两个密钥留空即关闭追踪，不影响对局流程。
  // 用 emptyToUndefined 兜住 .env 里「变量存在但值为空」的写法，避免 url 校验直接拦下启动。
  LANGFUSE_PUBLIC_KEY: emptyToUndefined,
  LANGFUSE_SECRET_KEY: emptyToUndefined,
  LANGFUSE_HOST: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.url().default('http://localhost:3100'),
  ),
  LOG_LEVEL: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`环境变量校验失败: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

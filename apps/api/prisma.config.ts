import { config } from 'dotenv';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// 与应用一致：已导出的变量优先，其次本地配置，最后仓库默认配置。
const repositoryRoot = resolve(__dirname, '../..');
config({ path: resolve(repositoryRoot, '.env.local'), quiet: true });
config({ path: resolve(repositoryRoot, '.env'), quiet: true });

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('缺少环境变量 DATABASE_URL，请检查仓库根目录 .env.local 和 .env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // 用 tsx 而非 ts-node：generated Prisma Client 用了 NodeNext ESM 风格的 `.js` 扩展 import
    seed: 'node --import tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl,
  },
});

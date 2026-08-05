import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

// .env 在仓库根目录，CLI 从 apps/api 运行，需显式指向根 .env
config({ path: '../../.env' });

const databaseUrl = process.env['DATABASE_URL'];
if (!databaseUrl) {
  throw new Error('缺少环境变量 DATABASE_URL，请检查仓库根目录 .env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: databaseUrl,
  },
});

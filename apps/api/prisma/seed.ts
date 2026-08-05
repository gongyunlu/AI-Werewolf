import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { RulesetDefinitionSchema, type RulesetDefinition } from '../src/games/ruleset-definition';

// 6 人预女双民板：本次学习期主要用它跑通接口和主图
const std6p: { id: string; name: string; notes: string; definition: RulesetDefinition } = {
  id: 'std-6p-v1',
  name: '标准 6 人预女双民板',
  notes: 'Phase 2 验证用板：2 狼 + 预言家 + 女巫 + 2 平民',
  definition: {
    roles: [
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'werewolf', faction: 'werewolf' },
      { role: 'seer', faction: 'villager' },
      { role: 'witch', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
      { role: 'villager', faction: 'villager' },
    ],
  },
};

// 默认 Agent：跨对局持久身份，覆盖火山方舟的 6 个不同模型/厂商，方便 Phase 8 跨模型对抗
const defaultAgents: Array<{
  name: string;
  defaultModelName: string;
  memoryLabel: string;
  notes: string;
}> = [
  {
    name: '阿三',
    defaultModelName: 'deepseek-v4-pro',
    memoryLabel: '张三',
    notes: 'DeepSeek 顶级推理，默认开思考',
  },
  {
    name: '阿四',
    defaultModelName: 'deepseek-v4-flash',
    memoryLabel: '李四',
    notes: 'DeepSeek 快速版，Agent 能力强',
  },
  {
    name: '阿五',
    defaultModelName: 'doubao-seed-2.1-turbo',
    memoryLabel: '王五',
    notes: '豆包旗舰均衡型',
  },
  {
    name: '阿六',
    defaultModelName: 'doubao-seed-evolving',
    memoryLabel: '赵六',
    notes: '豆包最新代，1M 上下文',
  },
  {
    name: '阿七',
    defaultModelName: 'kimi-k3',
    memoryLabel: '钱七',
    notes: 'Kimi 旗舰，100 万 token 上下文',
  },
  { name: '阿八', defaultModelName: 'glm-5.2', memoryLabel: '孙八', notes: '智谱旗舰，长程任务强' },
];

async function main() {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    for (const ruleset of [std6p]) {
      // 落库前先用 zod 校验，避免 seed 数据和结构约定脱节
      const definition = RulesetDefinitionSchema.parse(ruleset.definition);
      await prisma.ruleset.upsert({
        where: { id: ruleset.id },
        create: {
          id: ruleset.id,
          name: ruleset.name,
          playerCount: definition.roles.length,
          definition,
          isFrozen: false,
          notes: ruleset.notes,
        },
        update: {
          name: ruleset.name,
          playerCount: definition.roles.length,
          definition,
          notes: ruleset.notes,
        },
      });
      console.log(`[seed] upsert ruleset ${ruleset.id} (${ruleset.name}) 完成`);
    }

    // Agent 用 name 作为 upsert 键（unique），重复跑 seed 不会重复创建
    for (const agent of defaultAgents) {
      await prisma.agent.upsert({
        where: { name: agent.name },
        create: {
          name: agent.name,
          defaultModelName: agent.defaultModelName,
          memoryLabel: agent.memoryLabel,
          notes: agent.notes,
        },
        update: {
          defaultModelName: agent.defaultModelName,
          memoryLabel: agent.memoryLabel,
          notes: agent.notes,
        },
      });
      console.log(`[seed] upsert agent ${agent.name} (${agent.defaultModelName}) 完成`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] 失败：', err);
  process.exit(1);
});

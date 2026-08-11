import { PrismaService } from '@/prisma/prisma.service';
import { config } from 'dotenv';

// 加载环境变量
config({ path: '../../.env' });
config({ path: '../../.env.local', override: true });

/**
 * 验证 Event 表写入是否完整
 */
async function main() {
  const prisma = new PrismaService();

  try {
    const testGameId = '00000000-0000-0000-0000-000000000001';

    console.log('📋 查询游戏事件记录...');
    console.log('');

    const events = await prisma.event.findMany({
      where: {
        gameId: testGameId,
      },
      orderBy: [{ day: 'asc' }, { sequence: 'asc' }],
    });

    if (events.length === 0) {
      console.log('⚠️  未找到任何事件');
      console.log('   可能原因：测试游戏还未运行');
      return;
    }

    console.log(`✅ 找到 ${events.length} 条事件记录`);
    console.log('');

    // 按事件类型分组统计
    const eventTypes = new Map<string, number>();
    events.forEach((e) => {
      eventTypes.set(e.actionType, (eventTypes.get(e.actionType) || 0) + 1);
    });

    console.log('📊 事件类型统计：');
    eventTypes.forEach((count, type) => {
      console.log(`   ${type}: ${count} 条`);
    });
    console.log('');

    // 显示最近 20 条事件
    console.log('📜 最近 20 条事件：');
    console.log('');

    events.slice(-20).forEach((event, index) => {
      const content = event.content as Record<string, unknown>;
      let description = '';

      switch (event.actionType) {
        case 'seer_check':
          description = `预言家查验 ${content.targetSeatNo}号位 → ${content.result}`;
          break;
        case 'wolf_kill':
          description = `狼人刀 ${content.targetSeatNo}号位`;
          break;
        case 'witch_antidote':
          description = `女巫使用解药救 ${content.targetSeatNo}号位`;
          break;
        case 'witch_poison':
          description = `女巫使用毒药毒 ${content.targetSeatNo}号位`;
          break;
        case 'death_announcement':
          const deaths = (content.deaths || []) as Array<{ seatNo: number; cause: string }>;
          description = `死亡公告: ${deaths.map((d) => `${d.seatNo}号位(${d.cause})`).join(', ')}`;
          break;
        case 'peaceful_night':
          description = `平安夜`;
          break;
        default:
          description = `${event.actionType}`;
      }

      console.log(
        `${events.length - 20 + index + 1}. Day ${event.day} [${event.phase}] ${description}`,
      );
    });

    console.log('');
    console.log('✅ Event 表写入验证完成！');
  } catch (error) {
    console.error('❌ 查询失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);

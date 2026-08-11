import { PrismaService } from '@/prisma/prisma.service';
import { config } from 'dotenv';
import { ACTION_TYPES } from '@ai-werewolf/shared';

// 加载环境变量
config({ path: '../../.env' });
config({ path: '../../.env.local', override: true });

/**
 * 验证预言家查验历史是否写入 Event 表
 */
async function main() {
  const prisma = new PrismaService();

  try {
    const testGameId = '00000000-0000-0000-0000-000000000001';

    console.log('🔍 查询预言家查验历史...');
    console.log('');

    const seerCheckEvents = await prisma.event.findMany({
      where: {
        gameId: testGameId,
        actionType: ACTION_TYPES.SEER_CHECK,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (seerCheckEvents.length === 0) {
      console.log('⚠️  未找到预言家查验事件');
      console.log('   可能原因：测试游戏还未运行，或预言家已死亡');
    } else {
      console.log(`✅ 找到 ${seerCheckEvents.length} 条预言家查验记录：`);
      console.log('');

      seerCheckEvents.forEach((event, index) => {
        const content = event.content as any;
        console.log(
          `${index + 1}. Day ${event.day}: 查验 ${content.targetSeatNo}号位 → ${content.result}`,
        );
      });

      console.log('');
      console.log('📊 验证结果：');

      // 检查是否有重复查验
      const checkedSeats = seerCheckEvents.map((e) => (e.content as any).targetSeatNo);
      const uniqueSeats = new Set(checkedSeats);

      if (checkedSeats.length > uniqueSeats.size) {
        console.log('❌ 发现重复查验！');
        console.log(`   查验过的座位号: ${checkedSeats.join(', ')}`);
        console.log(`   去重后: ${Array.from(uniqueSeats).join(', ')}`);
      } else {
        console.log('✅ 无重复查验');
        console.log(`   查验过的座位号: ${checkedSeats.join(', ')}`);
      }
    }
  } catch (error) {
    console.error('❌ 查询失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(console.error);

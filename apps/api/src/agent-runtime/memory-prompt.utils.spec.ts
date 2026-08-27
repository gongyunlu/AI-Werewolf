import type { ActiveMemory } from '../memory/memory.service';
import { formatMemorySection } from './memory-prompt.utils';

describe('formatMemorySection', () => {
  it('按检索顺序聚合全部同类型记忆', () => {
    const memories: ActiveMemory[] = [
      { id: '1', type: 'persona', title: '性格', content: '谨慎', importance: 10 },
      { id: '2', type: 'strategy', title: '策略', content: '先听后说', importance: 9 },
      { id: '3', type: 'persona', title: '表达', content: '言简意赅', importance: 8 },
    ];

    expect(formatMemorySection(memories, 'persona')).toBe('### 性格\n谨慎\n\n### 表达\n言简意赅');
  });
});

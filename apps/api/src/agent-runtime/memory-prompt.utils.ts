import type { MemoryType } from '@ai-werewolf/shared';
import type { ActiveMemory } from '../memory/memory.service';

export function formatMemorySection(memories: ActiveMemory[], type: MemoryType): string {
  return memories
    .filter((memory) => memory.type === type)
    .map((memory) => `### ${memory.title}\n${memory.content}`)
    .join('\n\n');
}

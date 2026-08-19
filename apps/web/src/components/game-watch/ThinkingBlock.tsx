import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Streamdown } from 'streamdown';

interface ThinkingBlockProps {
  thinking: string;
  duration?: number; // 推理用时（毫秒）
  defaultOpen?: boolean; // 流式渲染中默认展开
}

export function ThinkingBlock({ thinking, duration, defaultOpen = false }: ThinkingBlockProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const durationText = duration ? `用时 ${(duration / 1000).toFixed(1)} 秒` : '';

  return (
    <div className="mb-3 overflow-hidden rounded-lg border border-blue-200/30 bg-blue-950/20">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-blue-100/80 transition-colors hover:bg-blue-950/40"
      >
        <span className="text-base">🧠</span>
        <span className="flex-1">已思考{durationText ? `（${durationText}）` : ''}</span>
        <ChevronDown className={cn('size-4 transition-transform', isOpen && 'rotate-180')} />
      </button>

      {isOpen && (
        <div className="border-t border-blue-200/20 px-3 py-2.5 text-sm text-blue-50/70">
          <Streamdown className="prose prose-invert prose-sm max-w-none">{thinking}</Streamdown>
        </div>
      )}
    </div>
  );
}

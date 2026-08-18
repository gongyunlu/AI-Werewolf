/** 打字机速率控制器（双缓冲 + rAF） */
export type ContentType = 'thinking' | 'content';

const SPEEDS: Record<ContentType, number> = {
  thinking: 15, // 字符/秒
  content: 10,
};

/** 非流式场景关闭后最小停留时间（ms） */
export const HOLD_UNTIL_MS: Record<string, number> = {
  judge: 2000,
  system: 1500,
  night_prompt: 2500,
  vote: 800,
  night_action: 1500,
  speech: 0,
  last_words: 0,
};

export class RenderScheduler {
  private readonly contentType: ContentType;
  private readonly onUpdate: (text: string) => void;
  private accumBuffer = '';
  private displayBuffer = '';
  private rafId: number | null = null;
  private lastFlushTime = 0;

  constructor(contentType: ContentType, onUpdate: (text: string) => void) {
    this.contentType = contentType;
    this.onUpdate = onUpdate;
  }

  push(token: string): void {
    this.accumBuffer += token;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame(this.flush);
  }

  private flush = (): void => {
    this.rafId = null;
    const now = performance.now();
    const elapsed = now - this.lastFlushTime;
    const charsPerMs = SPEEDS[this.contentType] / 1000;
    const maxChars = Math.floor(elapsed * charsPerMs);

    if (maxChars <= 0) {
      this.scheduleFlush();
      return;
    }

    const chunk = this.accumBuffer.slice(0, maxChars);
    this.accumBuffer = this.accumBuffer.slice(maxChars);
    this.displayBuffer += chunk;
    this.lastFlushTime = now;
    this.onUpdate(this.displayBuffer);

    if (this.accumBuffer.length > 0) {
      this.scheduleFlush();
    }
  };

  destroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}

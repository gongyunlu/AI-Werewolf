import { Controller, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, defer, mergeMap } from 'rxjs';

@Controller('debug')
export class TestSseController {
  @Sse('test-sse')
  testSse(): Observable<MessageEvent> {
    return interval(1000).pipe(
      map((n) => ({
        data: `chunk ${n}`,
      })),
    );
  }

  @Sse('test-async')
  testAsync(): Observable<MessageEvent> {
    // 模拟异步初始化（类似 LangChain 的 chain.stream()）
    return defer(() => Promise.resolve(['chunk1', 'chunk2', 'chunk3'])).pipe(
      mergeMap((chunks) => chunks),
      map((chunk) => ({ data: chunk })),
    );
  }
}

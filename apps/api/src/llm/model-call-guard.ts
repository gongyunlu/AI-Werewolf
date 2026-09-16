import { OpenAIClient } from '@langchain/openai';
import { isNativeError } from 'node:util/types';

export type ModelFailureCode =
  'transient' | 'invalid_output' | 'circuit_open' | 'fatal' | 'deadline' | 'budget_exhausted';
export type ModelCallMode = 'invoke' | 'stream';
type TimeoutPhase = 'first_chunk' | 'idle' | 'total';

export interface ModelFailureDetails {
  reason?: 'timeout' | 'schema_validation' | 'parse_error' | 'empty_output' | 'truncated_output';
  timeoutMs?: number;
  timeoutPhase?: TimeoutPhase;
  elapsedMs?: number;
  httpStatus?: number;
  providerCode?: string;
  errorType?: string;
  causes?: Array<{ errorType: string; code?: string }>;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  partialOutput?: boolean;
}

/** 失败分类决定调用策略，不生成替代行动。 */
export class ModelCallError extends Error {
  constructor(
    readonly code: ModelFailureCode,
    options?: ErrorOptions,
    readonly retryAt?: number,
    readonly details: ModelFailureDetails = {},
  ) {
    const detail = details.reason
      ? ` (${details.reason}${details.timeoutPhase ? `:${details.timeoutPhase}` : ''}${details.timeoutMs ? `, ${details.timeoutMs} ms` : ''})`
      : '';
    super(`模型调用失败: ${code}${detail}`, options);
    this.name = 'ModelCallError';
  }
}

interface Circuit {
  samples: Array<{ at: number; failed: boolean }>;
  openUntil: number;
  probing: boolean;
  generation: number;
}

interface GuardOptions {
  timeoutMs?: number;
  firstChunkTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  streamTimeoutMs?: number;
  windowMs?: number;
  minSamples?: number;
  failureRatio?: number;
  cooldownMs?: number;
}

function classify(error: unknown): 'transient' | 'invalid_output' | 'fatal' {
  if (!(error instanceof Error)) return 'fatal';
  const details = error as Error & {
    status?: number;
    code?: string;
    type?: string;
    lc_error_code?: string;
  };
  // 配额耗尽与短暂限流可能同为 429；立即重试不能补充配额。
  if (
    details.code === 'AccountQuotaExceeded' ||
    details.code === 'insufficient_quota' ||
    details.type === 'insufficient_quota'
  )
    return 'fatal';
  if (details.status === 408 || details.status === 429 || (details.status ?? 0) >= 500)
    return 'transient';
  if (details.status) return 'fatal';
  // OpenAI SDK 对流内 error 抛 APIError，但不保留 HTTP 状态；按明确的方舟错误码分类。
  if (details.code === 'ServerOverloaded' || details.code === 'RequestBurstTooFast')
    return 'transient';
  if (
    // SDK 的连接异常（含超时子类）沿用 name="Error"，必须按真实类型识别。
    error instanceof OpenAIClient.APIConnectionError ||
    error.name === 'TimeoutError' ||
    ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(details.code ?? '')
  )
    return 'transient';
  if (error.name === 'ZodError' || details.lc_error_code === 'OUTPUT_PARSING_FAILURE')
    return 'invalid_output';
  return 'fatal';
}

/** 进程内按模型路由隔离故障；重试由调用方统一计数。 */
export class ModelCallGuard {
  private readonly circuits = new Map<string, Circuit>();
  private readonly options: Required<GuardOptions>;

  constructor(options: GuardOptions = {}) {
    this.options = {
      timeoutMs: options.timeoutMs ?? 300_000,
      firstChunkTimeoutMs: options.firstChunkTimeoutMs ?? 300_000,
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 300_000,
      streamTimeoutMs: options.streamTimeoutMs ?? 900_000,
      windowMs: options.windowMs ?? 60_000,
      minSamples: options.minSamples ?? 5,
      failureRatio: options.failureRatio ?? 0.6,
      cooldownMs: options.cooldownMs ?? 30_000,
    };
  }

  async run<T>(
    route: string,
    call: (signal: AbortSignal, reportProgress: () => void) => Promise<T>,
    parentSignal?: AbortSignal,
    mode: ModelCallMode = 'invoke',
    maxDurationMs?: number,
  ): Promise<T> {
    parentSignal?.throwIfAborted();
    const circuit = this.circuits.get(route) ?? {
      samples: [],
      openUntil: 0,
      probing: false,
      generation: 0,
    };
    this.circuits.set(route, circuit);
    if (circuit.openUntil > Date.now() || circuit.probing)
      throw new ModelCallError(
        'circuit_open',
        undefined,
        circuit.probing ? Date.now() + this.options.cooldownMs : circuit.openUntil,
      );
    const probe = circuit.openUntil > 0;
    if (probe) circuit.probing = true;
    const generation = circuit.generation;
    const startedAt = Date.now();
    const controller = new AbortController();
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, controller.signal])
      : controller.signal;
    let active = true;
    let expired: { timeoutPhase: TimeoutPhase; timeoutMs: number } | undefined;
    const expire = (timeoutPhase: TimeoutPhase, timeoutMs: number) => {
      if (!active || signal.aborted) return;
      expired = { timeoutPhase, timeoutMs };
      controller.abort(new DOMException(`模型调用超时: ${timeoutPhase}`, 'TimeoutError'));
    };
    const totalMs = Math.min(
      maxDurationMs ?? Infinity,
      mode === 'stream' ? this.options.streamTimeoutMs : this.options.timeoutMs,
    );
    const timeout = setTimeout(() => expire('total', totalMs), totalMs);
    let progressTimeout: ReturnType<typeof setTimeout> | undefined;
    if (mode === 'stream') {
      progressTimeout = setTimeout(
        () => expire('first_chunk', this.options.firstChunkTimeoutMs),
        this.options.firstChunkTimeoutMs,
      );
    }
    // 仅由有效模型片段刷新；总期限不随流片段延长。
    const reportProgress = () => {
      if (!active || signal.aborted || mode !== 'stream') return;
      clearTimeout(progressTimeout);
      progressTimeout = setTimeout(
        () => expire('idle', this.options.streamIdleTimeoutMs),
        this.options.streamIdleTimeoutMs,
      );
    };
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([call(signal, reportProgress), cancelled]);
      signal.throwIfAborted();
      if (generation === circuit.generation) {
        if (probe) {
          circuit.openUntil = 0;
          circuit.samples = [];
          circuit.generation++;
        } else this.record(circuit, false);
      }
      return result;
    } catch (error) {
      if (parentSignal?.aborted) throw parentSignal.reason;
      if (error instanceof ModelCallError && !controller.signal.aborted) throw error;
      const kind = controller.signal.aborted ? 'transient' : classify(error);
      if (kind === 'transient' && generation === circuit.generation) {
        if (probe) this.open(circuit);
        else this.record(circuit, true);
      }
      if (kind === 'transient') {
        const headers = (error as { headers?: { get?: (key: string) => string | null } }).headers;
        const retryAfter = headers?.get?.('retry-after');
        if (retryAfter) {
          const delay = /^\d+(\.\d+)?$/.test(retryAfter)
            ? Number(retryAfter) * 1000
            : Date.parse(retryAfter) - Date.now();
          if (Number.isFinite(delay) && delay > 0 && Date.now() + delay > circuit.openUntil)
            this.open(circuit, delay);
        }
      }
      if (kind === 'fatal') throw error;
      const httpStatus = (error as { status?: number }).status;
      const providerCode = (error as { code?: unknown }).code;
      const causes: NonNullable<ModelFailureDetails['causes']> = [];
      // SDK → fetch → 网络错误；只取类型和错误码，避免原因消息带出 URL、凭据或响应正文。
      for (
        let cause = error instanceof Error ? error.cause : undefined;
        (cause instanceof Error || isNativeError(cause)) && causes.length < 3;
        cause = cause.cause
      ) {
        const code = (cause as Error & { code?: unknown }).code;
        causes.push({
          errorType: cause.name === 'Error' ? cause.constructor.name : cause.name,
          ...(typeof code === 'string' ? { code } : {}),
        });
      }
      throw new ModelCallError(kind, { cause: error }, circuit.openUntil || undefined, {
        elapsedMs: Date.now() - startedAt,
        ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
        ...(typeof providerCode === 'string' ? { providerCode } : {}),
        ...(error instanceof Error
          ? { errorType: error.name === 'Error' ? error.constructor.name : error.name }
          : {}),
        ...(causes.length ? { causes } : {}),
        ...(controller.signal.aborted
          ? { reason: 'timeout', ...expired }
          : kind === 'invalid_output'
            ? {
                reason:
                  error instanceof Error && error.name === 'ZodError'
                    ? 'schema_validation'
                    : 'parse_error',
              }
            : {}),
      });
    } finally {
      active = false;
      clearTimeout(timeout);
      clearTimeout(progressTimeout);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (probe) circuit.probing = false;
    }
  }

  private record(circuit: Circuit, failed: boolean): void {
    const now = Date.now();
    circuit.samples = circuit.samples.filter((s) => now - s.at < this.options.windowMs);
    circuit.samples.push({ at: now, failed });
    if (
      circuit.samples.length >= this.options.minSamples &&
      circuit.samples.filter((s) => s.failed).length / circuit.samples.length >=
        this.options.failureRatio
    )
      this.open(circuit);
  }

  private open(circuit: Circuit, delay = this.options.cooldownMs): void {
    circuit.openUntil = Date.now() + Math.max(delay, this.options.cooldownMs);
    circuit.generation++;
  }
}

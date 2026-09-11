export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  const error = new Error('LLM generation aborted');
  error.name = 'AbortError';
  throw error;
}

export function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (error instanceof Error && (error.name === 'AbortError' || error.message.includes('aborted')))
  );
}

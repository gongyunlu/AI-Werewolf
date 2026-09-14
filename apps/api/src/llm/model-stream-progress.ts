import { isAIMessageChunk, type AIMessageChunk } from '@langchain/core/messages';
import {
  BaseCallbackHandler,
  type CallbackHandlerPrefersStreaming,
  type HandleLLMNewTokenCallbackFields,
  type NewTokenIndices,
} from '@langchain/core/callbacks/base';

/** 选择 LangChain 的流聚合路径，直接使用供应商 usage，无需另行下载 tokenizer 估算。 */
export class ModelStreamProgressHandler
  extends BaseCallbackHandler
  implements CallbackHandlerPrefersStreaming
{
  name = 'model-stream-progress';
  lc_prefer_streaming = true;
  /**
   * 模型原文。结构化输出在解析阶段抛错时，异常不携带原文，重试会退化成
   * 把同样的输入再发一遍；从流式分片里留存下来才能让重试带上待修正的内容。
   */
  rawContent = '';
  rawToolName = '';
  rawToolArguments = '';

  constructor(
    private readonly progress: ReturnType<typeof createStreamProgress>,
    private readonly signal: AbortSignal,
    private readonly reportProgress: () => void,
  ) {
    super({ _awaitHandler: true });
  }

  override handleLLMNewToken(
    _token: string,
    _indices: NewTokenIndices,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    fields?: HandleLLMNewTokenCallbackFields,
  ) {
    if (this.signal.aborted) return;
    const generation = fields?.chunk;
    if (generation && 'message' in generation && isAIMessageChunk(generation.message)) {
      const message = generation.message;
      recordStreamProgress(this.progress, message, this.reportProgress);
      if (typeof message.content === 'string') this.rawContent += message.content;
      for (const tool of message.tool_call_chunks ?? []) {
        this.rawToolArguments += tool.args ?? '';
        if (tool.name && !this.rawToolName) this.rawToolName = tool.name;
      }
      const finishReason = generation.generationInfo?.finish_reason;
      if (typeof finishReason === 'string') this.progress.finishReason = finishReason;
    }
  }
}

export function createStreamProgress() {
  return {
    receivedChunks: 0,
    contentChars: 0,
    reasoningChars: 0,
    toolArgumentChars: 0,
    finishReason: undefined as string | undefined,
    inputTokens: undefined as number | undefined,
    outputTokens: undefined as number | undefined,
  };
}

/** 心跳、角色和工具 ID 不代表模型仍在生成有效内容。 */
export function recordStreamProgress(
  progress: ReturnType<typeof createStreamProgress>,
  chunk: AIMessageChunk,
  reportProgress: () => void,
) {
  progress.receivedChunks++;
  const content = typeof chunk.content === 'string' ? chunk.content : '';
  const reasoning = chunk.additional_kwargs?.reasoning_content;
  const reasoningText = typeof reasoning === 'string' ? reasoning : '';
  const argumentsText = (chunk.tool_call_chunks ?? []).map((tool) => tool.args ?? '').join('');
  if (content.trim() || reasoningText.trim() || argumentsText.trim()) reportProgress();
  progress.contentChars += content.length;
  progress.reasoningChars += reasoningText.length;
  progress.toolArgumentChars += argumentsText.length;
  const finishReason = chunk.response_metadata?.finish_reason;
  if (typeof finishReason === 'string') progress.finishReason = finishReason;
  if (chunk.usage_metadata) {
    progress.inputTokens = chunk.usage_metadata.input_tokens;
    progress.outputTokens = chunk.usage_metadata.output_tokens;
  }
}

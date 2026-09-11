import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Env } from '../config/env.validation';
import type { FrozenPrompts } from '../evaluation/experiment-snapshot';
import { LangfuseService } from '../observability/langfuse.service';
import { PromptService, type RenderedPrompt } from '../observability/prompt.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import { ModelCallService } from '../llm/model-call.service';
import { canonicalJson } from '../llm/canonical-json';
import { throwIfAborted } from '../llm/abort.utils';
import {
  reflectTurn,
  TurnReviewSchema,
  SpeechRevisionSchema,
  applySpeechRevision,
} from './turn-reflection';

/** 只包含已授权输入与追踪标识，生成器不持有数据库玩家对象或历史存储。 */
export interface TurnGenerationContext {
  systemPrompt: string;
  player: {
    id: string;
    gameId: string;
    modelName: string;
    seatNo?: number | null;
    role?: string | null;
  };
  scenario: string;
  prompts?: FrozenPrompts;
  replay?: Record<string, unknown>;
  reflectionMaxRounds?: number;
}

/** 在线与诊断共用的候选生成和有界反思；结果是否提交由应用层决定。 */
@Injectable()
export class PlayerTurnService {
  private readonly logger = new Logger(PlayerTurnService.name);
  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly modelCalls: ModelCallService,
    private readonly promptService: PromptService,
    private readonly langfuse: LangfuseService,
  ) {}

  async speech(
    context: TurnGenerationContext,
    history: BaseMessage[],
    options: {
      signal?: AbortSignal;
      onThinking?: (token: string) => void;
      onContent?: (token: string) => void;
    },
  ) {
    const { signal, onThinking, onContent } = options;
    const reviewing =
      (context.reflectionMaxRounds ?? this.configService.get('TURN_REFLECTION_MAX_ROUNDS') ?? 3) >
      0;
    throwIfAborted(signal);
    const startTime = Date.now();
    const modelName = context.player.modelName;

    const traceParams = {
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
    };

    const thinkingPrompt = await this.promptService.render(
      PROMPT_NAMES.agentSpeechThinking,
      undefined,
      context.prompts,
    );
    const thinkingTrace = this.langfuse.trace({
      runName: 'speech-thinking',
      ...traceParams,
      promptName: thinkingPrompt.name,
      promptVersion: thinkingPrompt.version,
    });
    const thinkingMessages = [
      new SystemMessage(context.systemPrompt),
      ...history,
      new HumanMessage(thinkingPrompt.text),
    ];

    // 阶段1：流式输出思考
    const thinking = await this.modelCalls.streamText(
      modelName,
      thinkingMessages,
      signal,
      reviewing ? undefined : onThinking,
      thinkingTrace,
    );

    throwIfAborted(signal);
    const contentStartTime = Date.now();
    const contentPrompt = await this.promptService.render(
      PROMPT_NAMES.agentSpeechContent,
      {
        thinking,
      },
      context.prompts,
    );
    const contentTrace = this.langfuse.trace({
      runName: 'speech-content',
      ...traceParams,
      promptName: contentPrompt.name,
      promptVersion: contentPrompt.version,
    });
    const contentMessages = [
      new SystemMessage(context.systemPrompt),
      new HumanMessage(contentPrompt.text),
    ];

    // 阶段2：流式输出发言正文
    const content = await this.modelCalls.streamText(
      modelName,
      contentMessages,
      signal,
      reviewing ? undefined : onContent,
      contentTrace,
    );

    const final = await this.reflectCandidate(
      context,
      { reasoning: thinking, content },
      z.object({ reasoning: z.string().min(1), content: z.string().min(1) }),
      'speech',
      signal,
      history,
    );
    throwIfAborted(signal);
    if (reviewing) {
      onThinking?.(final.reasoning);
      onContent?.(final.content);
    }
    const contentEndTime = Date.now();
    return {
      thinking: final.reasoning,
      content: final.content,
      thinkingDurationMs: contentStartTime - startTime,
      contentDurationMs: contentEndTime - contentStartTime,
    };
  }

  async decide<T>(
    context: TurnGenerationContext,
    zodSchema: z.ZodType,
    history: BaseMessage[],
    signal?: AbortSignal,
    frozenOutputSchema?: Record<string, unknown>,
  ): Promise<{ reasoning: string; decision: T }> {
    throwIfAborted(signal);
    const outputSchema = z.object({
      reasoning: z.string().min(1).describe('依据本局可见信息，解释本次最终动作的理由'),
      decision: zodSchema,
    });
    const wireSchema = frozenOutputSchema ?? z.toJSONSchema(outputSchema);
    if (context.replay)
      Object.assign(context.replay, {
        schema: z.toJSONSchema(zodSchema),
        outputSchema: wireSchema,
        decisionMode: 'joint',
        reasoningHistory: history.map((m) => ({ type: m.getType(), content: m.content })),
      });
    const systemPrompt = await this.promptService.render(
      PROMPT_NAMES.agentActionSystem,
      { systemPrompt: context.systemPrompt },
      context.prompts,
    );
    const baseMessages = [
      new SystemMessage(systemPrompt.text),
      ...history,
      new HumanMessage('请提交本次的 reasoning 和 decision，理由与最终动作必须一致。'),
    ];
    const draft = await this.invokeTurnStructured(
      context,
      outputSchema,
      baseMessages,
      systemPrompt,
      'decision',
      signal,
      wireSchema,
    );
    const result = await this.reflectCandidate(
      context,
      draft,
      outputSchema,
      'decision',
      signal,
      history,
      wireSchema,
    );

    if (context.replay)
      Object.assign(context.replay, {
        reasoning: result.reasoning,
        decision: result.decision,
      });

    return { reasoning: result.reasoning, decision: result.decision as T };
  }

  private invokeTurnStructured<S extends z.ZodType>(
    context: TurnGenerationContext,
    schema: S,
    messages: BaseMessage[],
    prompt: RenderedPrompt,
    runName: string,
    signal?: AbortSignal,
    wireSchema?: Record<string, unknown>,
  ): Promise<z.infer<S>> {
    return this.modelCalls.structured(
      context.player.modelName,
      schema,
      messages,
      (retry) =>
        this.langfuse.trace({
          runName: runName + (retry ? '-retry' : ''),
          gameId: context.player.gameId,
          playerId: context.player.id,
          modelName: context.player.modelName,
          scenario: context.scenario,
          seatNo: context.player.seatNo,
          role: context.player.role,
          promptName: prompt.name,
          promptVersion: prompt.version,
        }),
      signal,
      wireSchema,
    );
  }

  private async reflectCandidate<S extends z.ZodType>(
    context: TurnGenerationContext,
    initial: z.infer<S>,
    schema: S,
    task: 'speech' | 'decision',
    signal?: AbortSignal,
    history: BaseMessage[] = [],
    candidateSchema: Record<string, unknown> = z.toJSONSchema(schema),
  ): Promise<z.infer<S>> {
    const maxRounds =
      context.reflectionMaxRounds ?? this.configService.get('TURN_REFLECTION_MAX_ROUNDS') ?? 3;
    if (context.replay) context.replay.reflectionMaxRounds = maxRounds;
    const assistantHistory = history.map((message) => ({
      type: message.getType(),
      content: message.content,
    }));
    const evidence = (context.replay?.evidence ?? []) as Array<{ sequence: number }>;
    const sequences = evidence.map((e) => e.sequence);
    const call = async <R extends z.ZodType>(
      name: typeof PROMPT_NAMES.agentTurnReflect | typeof PROMPT_NAMES.agentTurnRevise,
      output: R,
      candidate: z.infer<S>,
      round: number,
      review?: unknown,
    ): Promise<z.infer<R>> => {
      const responseSchema =
        task === 'decision' && name === PROMPT_NAMES.agentTurnRevise
          ? candidateSchema
          : z.toJSONSchema(output);
      const prompt = await this.promptService.render(
        name,
        {
          context: context.systemPrompt + '\n' + canonicalJson({ assistantHistory }),
          task,
          candidateSchema: canonicalJson(candidateSchema),
          responseSchema: canonicalJson(responseSchema),
          candidate: canonicalJson(candidate),
          review: canonicalJson(review ?? {}),
          evidenceSequences: JSON.stringify(sequences),
        },
        context.prompts,
      );
      return this.invokeTurnStructured(
        context,
        output,
        [new SystemMessage(prompt.text), new HumanMessage('请按指定结构返回完整结果。')],
        prompt,
        name.split('/')[1] + '-' + round,
        signal,
        responseSchema,
      );
    };
    const audit = await reflectTurn({
      initial,
      maxRounds,
      signal,
      evidenceSequences: new Set(sequences),
      review: (candidate, round) =>
        call(PROMPT_NAMES.agentTurnReflect, TurnReviewSchema, candidate, round),
      revise: async (candidate, review, round) => {
        if (task === 'decision')
          return call(PROMPT_NAMES.agentTurnRevise, schema, candidate, round, review);
        const speech = candidate as { reasoning: string; content: string };
        const revisionSchema = SpeechRevisionSchema.superRefine((revision, ctx) => {
          try {
            applySpeechRevision(speech, revision);
          } catch (error) {
            ctx.addIssue({
              code: 'custom',
              message: (error as Error).message,
              path: ['contentEdits'],
            });
          }
        });
        const revision = await call(
          PROMPT_NAMES.agentTurnRevise,
          revisionSchema,
          candidate,
          round,
          review,
        );
        return schema.parse(applySpeechRevision(speech, revision));
      },
    });
    if (context.replay) context.replay.reflection = { ...audit, assistantHistory };
    if (audit.status !== 'passed' && audit.status !== 'disabled') {
      this.logger.warn({
        message: '玩家反思仍有未解决的质量问题，保留最终合法候选',
        gameId: context.player.gameId,
        playerId: context.player.id,
        status: audit.status,
      });
    }
    return audit.final;
  }
}

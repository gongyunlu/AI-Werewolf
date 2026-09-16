import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemMessage, HumanMessage, AIMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Env } from '../config/env.validation';
import type { FrozenPrompts } from '../evaluation/experiment-snapshot';
import { LangfuseService } from '../observability/langfuse.service';
import { PromptService, type RenderedPrompt } from '../observability/prompt.service';
import { PROMPT_NAMES } from '../observability/prompt-templates';
import type { ModelAccess } from '../llm/model-call.service';
import { ModelGenerationService } from '../llm/model-generation.service';
import { throwIfAborted } from '../llm/abort.utils';
import { type ActionSource } from '../observability/action-source';

/** 只包含已授权输入与追踪标识，生成器不持有数据库玩家对象或历史存储。 */
export interface TurnGenerationContext {
  actionKey?: string;
  source?: ActionSource;
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
  /** 该玩家在本局固定使用的接入端点；缺省时用环境变量默认接入。 */
  access?: ModelAccess;
}

/** 单次模型调用要带上的一局标识，不含随轮次变化的字段。 */
type TraceParams = Omit<
  Parameters<LangfuseService['trace']>[0],
  'runName' | 'promptName' | 'promptVersion'
>;

/** 在线与诊断共用的候选生成；结果是否提交由应用层决定。 */
@Injectable()
export class PlayerTurnService {
  constructor(
    private readonly configService: ConfigService<Env, true>,
    private readonly modelCalls: ModelGenerationService,
    private readonly promptService: PromptService,
    private readonly langfuse: LangfuseService,
  ) {}

  async speech(
    context: TurnGenerationContext,
    options: {
      signal?: AbortSignal;
      onThinking?: (token: string) => void;
      onContent?: (token: string) => void;
      /** 覆盖本局的反思轮次；狼队夜间讨论自身的迭代已经足够，不需要再叠加。 */
      reflectionMaxRounds?: number;
    },
  ) {
    const { signal, onThinking, onContent } = options;
    throwIfAborted(signal);
    await this.beginAttempt(context);
    const startTime = Date.now();
    const modelName = context.player.modelName;

    const traceParams: TraceParams = {
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
      source: context.source,
    };

    const thinkingPrompt = await this.promptService.render(
      PROMPT_NAMES.agentSpeechThinking,
      undefined,
      context.prompts,
    );
    const { thinkingRounds } = await this.generateThinking({
      context,
      systemPrompt: context.systemPrompt,
      firstPrompt: thinkingPrompt,
      runName: 'speech-thinking',
      traceParams,
      rounds: this.resolveReflectionRounds(context, options.reflectionMaxRounds),
      signal,
      onThinking,
    });
    const thinking = thinkingRounds.join('\n\n');

    throwIfAborted(signal);
    const contentStartTime = Date.now();
    const contentPrompt = await this.promptService.render(
      PROMPT_NAMES.agentSpeechContent,
      {
        thinking,
      },
      context.prompts,
    );
    const contentTrace = (retry: boolean) =>
      this.langfuse.trace({
        runName: 'speech-content' + (retry ? '-retry' : ''),
        ...traceParams,
        promptName: contentPrompt.name,
        promptVersion: contentPrompt.version,
        promptSource: contentPrompt.source,
        promptOrigin: contentPrompt.origin,
      });

    // 终稿只有这一次调用，产出的正文即最终发言，因此可以一路逐 token 外发
    const content = await this.modelCalls.streamText(
      modelName,
      [new SystemMessage(context.systemPrompt), new HumanMessage(contentPrompt.text)],
      signal,
      onContent,
      contentTrace,
      context.access,
      'final',
      (id) => {
        if (context.source) context.source.outputObservationId = id;
      },
    );

    const contentEndTime = Date.now();
    return {
      thinking,
      content,
      thinkingDurationMs: contentStartTime - startTime,
      contentDurationMs: contentEndTime - contentStartTime,
    };
  }

  async decide<T>(
    context: TurnGenerationContext,
    zodSchema: z.ZodType,
    signal?: AbortSignal,
    options: {
      /** 覆盖本局的反思轮次；狼队夜间自身的迭代已经足够，不需要再叠加。 */
      reflectionMaxRounds?: number;
      /** 重放历史回合时使用的冻结输出契约。 */
      frozenOutputSchema?: Record<string, unknown>;
    } = {},
  ): Promise<{ reasoning: string; decision: T }> {
    throwIfAborted(signal);
    await this.beginAttempt(context);
    const outputSchema = z.object({
      reasoning: z.string().min(1).describe('依据本局可见信息，解释本次最终动作的理由'),
      decision: zodSchema,
    });
    const wireSchema = options.frozenOutputSchema ?? z.toJSONSchema(outputSchema);
    if (context.replay)
      Object.assign(context.replay, {
        schema: z.toJSONSchema(zodSchema),
        outputSchema: wireSchema,
        decisionMode: 'joint',
      });
    const traceParams: TraceParams = {
      gameId: context.player.gameId,
      playerId: context.player.id,
      modelName: context.player.modelName,
      scenario: context.scenario,
      seatNo: context.player.seatNo,
      role: context.player.role,
      source: context.source,
    };
    const systemPrompt = await this.promptService.render(
      PROMPT_NAMES.agentActionSystem,
      { systemPrompt: context.systemPrompt },
      context.prompts,
    );
    const thinkingPrompt = await this.promptService.render(
      PROMPT_NAMES.agentActionThinking,
      undefined,
      context.prompts,
    );
    const { history } = await this.generateThinking({
      context,
      systemPrompt: systemPrompt.text,
      firstPrompt: thinkingPrompt,
      runName: 'decision-thinking',
      traceParams,
      rounds: this.resolveReflectionRounds(context, options.reflectionMaxRounds),
      signal,
    });

    // 理由与动作一次成型，思考保留在会话历史里供本轮调用复用
    const result = await this.invokeTurnStructured(
      context,
      outputSchema,
      [
        ...history,
        new HumanMessage('请提交本次的 reasoning 和 decision，理由与最终动作必须一致。'),
      ],
      systemPrompt,
      'decision',
      signal,
      wireSchema,
    );

    if (context.replay)
      Object.assign(context.replay, {
        reasoning: result.reasoning,
        decision: result.decision,
      });

    return { reasoning: result.reasoning, decision: result.decision as T };
  }

  /**
   * 思考阶段：首轮形成初判，之后每一轮接着上一轮继续审视并纠正。
   *
   * 每轮都通过 `onThinking` 逐 token 外发。已经发出去的内容无法收回，所以后续轮次只能
   * 续写，提示词也明确要求只输出新增的判断，不重写前面的推理。
   *
   * 返回完整的会话历史，供需要复用思考的调用方接着生成终稿。
   */
  private async generateThinking(options: {
    context: TurnGenerationContext;
    systemPrompt: string;
    firstPrompt: RenderedPrompt;
    runName: string;
    traceParams: TraceParams;
    rounds: number;
    signal?: AbortSignal;
    onThinking?: (token: string) => void;
  }): Promise<{ history: BaseMessage[]; thinkingRounds: string[] }> {
    const { context, firstPrompt, signal, onThinking } = options;
    const continuation =
      options.rounds > 0
        ? await this.promptService.render(
            PROMPT_NAMES.agentTurnContinue,
            undefined,
            context.prompts,
          )
        : undefined;
    const history: BaseMessage[] = [
      new SystemMessage(options.systemPrompt),
      new HumanMessage(firstPrompt.text),
    ];
    const thinkingRounds: string[] = [];

    for (let round = 0; round <= options.rounds; round++) {
      throwIfAborted(signal);
      const prompt = round === 0 ? firstPrompt : continuation!;
      if (round > 0)
        history.push(
          new AIMessage(thinkingRounds[round - 1]),
          new HumanMessage(continuation!.text),
        );
      thinkingRounds.push(
        await this.modelCalls.streamText(
          context.player.modelName,
          history,
          signal,
          onThinking,
          (retry) =>
            this.langfuse.trace({
              runName: `${options.runName}-${round + 1}` + (retry ? '-retry' : ''),
              ...options.traceParams,
              promptName: prompt.name,
              promptVersion: prompt.version,
              promptSource: prompt.source,
              promptOrigin: prompt.origin,
            }),
          context.access,
          `thinking/${round}`,
        ),
      );
    }

    history.push(new AIMessage(thinkingRounds.at(-1)!));
    if (context.replay) {
      context.replay.reflectionMaxRounds = options.rounds;
      context.replay.thinkingRounds = thinkingRounds;
    }
    return { history, thinkingRounds };
  }

  private resolveReflectionRounds(
    context: TurnGenerationContext,
    override: number | undefined,
  ): number {
    return (
      override ??
      context.reflectionMaxRounds ??
      this.configService.get('TURN_REFLECTION_MAX_ROUNDS')
    );
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
      (retry) => {
        const trace = this.langfuse.trace({
          runName: runName + (retry ? '-retry' : ''),
          gameId: context.player.gameId,
          playerId: context.player.id,
          modelName: context.player.modelName,
          scenario: context.scenario,
          seatNo: context.player.seatNo,
          role: context.player.role,
          promptName: prompt.name,
          promptVersion: prompt.version,
          promptSource: prompt.source,
          promptOrigin: prompt.origin,
          source: context.source,
        });
        return trace;
      },
      signal,
      wireSchema,
      context.access,
      undefined,
      'final',
      (id) => {
        if (context.source) context.source.outputObservationId = id;
      },
    );
  }

  private async beginAttempt(context: TurnGenerationContext): Promise<void> {
    if (!context.actionKey) return;
    context.source = await this.modelCalls.beginAttempt(
      context.actionKey,
      context.player.gameId,
      context.player.id,
    );
  }
}

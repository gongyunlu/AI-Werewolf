import { Injectable, MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { Observable } from 'rxjs';
import type { Env } from '../config/env.validation';

@Injectable()
export class DebugService {
  constructor(private readonly configService: ConfigService<Env, true>) {}

  /**
   * 测试 LLM chat SSE 流式输出
   */
  chat(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const abort = new AbortController();

      const model = new ChatOpenAI({
        apiKey: this.configService.get('ARK_API_KEY'),
        model: this.configService.get('ARK_DEFAULT_MODEL'),
        configuration: {
          baseURL: this.configService.get('ARK_BASE_URL'),
        },
        streaming: true,
      });

      // 临时内联分层注入 prompt
      // 分层：框架层（规则+输出约束）→ 角色层（狼人视角）→ 场景层（当下局面）→ 触发（主持人递话筒）
      const prompt = ChatPromptTemplate.fromMessages([
        [
          'system',
          [
            '# 框架',
            '你正在参与一局标准 12 人狼人杀（预言家 / 女巫 / 猎人 / 守卫 / 狼王配置，简称"预女猎守狼王局"）。',
            '你必须完全代入所扮演的玩家，用第一人称口语化中文发言。',
            '',
            '## 输出规则（严格遵守）',
            '- 直接输出发言正文，不要写"作为4号玩家我认为..."这种旁白式开头，不要复述身份卡。',
            '- 不使用 markdown、不加粗、不列表、不出现表情符号。',
            '- 不暴露内心分析过程和思维链，只输出你打算让其他玩家听到的话。',
            '- 长度控制在 150~250 字，一段自然口语，不换行分段。',
            '- 严禁泄露自己的真实身份或队友身份（无论好人狼人都要伪装成好人视角发言）。',
          ].join('\n'),
        ],
        [
          'system',
          [
            '# 角色',
            '你的真实身份是**狼人**（这是只有你知道的秘密）。',
            '狼人首要目标：藏身份、带节奏、把好人票引向其他好人。',
            '发言基本原则：',
            '- 对外必须表现为普通好人：可以悍跳预言家 / 装深水 / 装普通村民，任选一种伪装策略并贯彻到底。',
            '- 保护队友但不能过于明显（避免站边、不主动为队友解释、可轻微质疑队友以做样子）。',
            '- 主动给场上其他好人贴"可疑"标签，制造好人内耗。',
          ].join('\n'),
        ],
        [
          'system',
          [
            '# 当前局面',
            '- 你是 4 号玩家。',
            '- 现在是第 1 天白天上警阶段，你选择了上警。',
            '- 警上玩家：1、2、4（你）、9、12 号。',
            '- 你已知情报（对外必须装作不知道）：1 号、9 号是你的狼队友；2 号、12 号是好人阵营，具体身份不明。',
            '- 发言顺序：你是第一个发言的警上玩家，后面还有 4 人依次发言，你的表态会定调整个警上轮次。',
          ].join('\n'),
        ],
        ['human', '主持人：请 4 号玩家开始你的上警发言。'],
      ]);

      const chain = prompt.pipe(model);

      void (async () => {
        try {
          const stream = await chain.stream({}, { signal: abort.signal });
          for await (const chunk of stream) {
            const text = chunk.additional_kwargs?.reasoning_content || chunk.content || '';
            if (text) {
              subscriber.next({ data: text });
            }
          }
          subscriber.complete();
        } catch (err) {
          // 客户端主动断开触发的 abort 不算错误，静默收尾即可
          if (!abort.signal.aborted) {
            subscriber.error(err);
          }
        }
      })();

      // 订阅取消时（客户端断开 / 异常）回调，中断上游 LLM 请求
      return () => abort.abort();
    });
  }
}

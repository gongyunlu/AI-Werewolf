import { Injectable } from '@nestjs/common';
import { nodeRegistry } from './node-registry';
import { WerewolfKillNode } from './night/werewolf-kill.node';
import { WitchAntidoteNode } from './night/witch-antidote.node';
import { WitchPoisonNode } from './night/witch-poison.node';
import { SeerCheckNode } from './night/seer-check.node';
import { SpeechNode } from './day/speech.node';
import { VoteNode } from './day/vote.node';
import { LastWordsNode } from './day/last-words.node';
import { ExileLastWordsNode } from './day/exile-last-words.node';
import { SheriffDecideOrderNode } from './day/sheriff-decide-order.node';
import { PkSpeechNode } from './day/pk-speech.node';
import { PkVoteNode } from './day/pk-vote.node';
import { WolfExplodeNode } from './day/wolf-explode.node';

/**
 * 节点注册器
 *
 * 集中持有所有节点实例,按节点名覆盖 nodeRegistry 中的默认注册，
 * 避免 GameEngine 构造函数逐个注入。
 */
@Injectable()
export class NodeRegistrar {
  constructor(
    private readonly werewolfKill: WerewolfKillNode,
    private readonly witchAntidote: WitchAntidoteNode,
    private readonly witchPoison: WitchPoisonNode,
    private readonly seerCheck: SeerCheckNode,
    private readonly speech: SpeechNode,
    private readonly vote: VoteNode,
    private readonly lastWords: LastWordsNode,
    private readonly exileLastWords: ExileLastWordsNode,
    private readonly sheriffDecideOrder: SheriffDecideOrderNode,
    private readonly pkSpeech: PkSpeechNode,
    private readonly pkVote: PkVoteNode,
    private readonly wolfExplode: WolfExplodeNode,
  ) {}

  /**
   * 覆盖注册所有两阶段节点
   */
  registerAll(): void {
    nodeRegistry.registerFactory('werewolfKill', this.werewolfKill.create());
    nodeRegistry.registerFactory('witchAntidote', this.witchAntidote.create());
    nodeRegistry.registerFactory('witchPoison', this.witchPoison.create());
    nodeRegistry.registerFactory('seerCheck', this.seerCheck.create());
    nodeRegistry.registerFactory('speech', this.speech.create());
    nodeRegistry.registerFactory('vote', this.vote.create());
    nodeRegistry.registerFactory('lastWords', this.lastWords.create());
    nodeRegistry.registerFactory('exileLastWords', this.exileLastWords.create());
    nodeRegistry.registerFactory('sheriffDecideOrder', this.sheriffDecideOrder.create());
    nodeRegistry.registerFactory('pkSpeech', this.pkSpeech.create());
    nodeRegistry.registerFactory('pkVote', this.pkVote.create());
    nodeRegistry.registerFactory('wolfExplode', this.wolfExplode.create());
  }
}

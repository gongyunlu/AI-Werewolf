import { Injectable } from '@nestjs/common';
import { NodeRegistry } from './node-registry';
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
 * 将本容器的节点实例一次性装配为只读注册表。
 */
@Injectable()
export class NodeRegistrar {
  readonly registry: NodeRegistry;

  constructor(
    werewolfKill: WerewolfKillNode,
    witchAntidote: WitchAntidoteNode,
    witchPoison: WitchPoisonNode,
    seerCheck: SeerCheckNode,
    speech: SpeechNode,
    vote: VoteNode,
    lastWords: LastWordsNode,
    exileLastWords: ExileLastWordsNode,
    sheriffDecideOrder: SheriffDecideOrderNode,
    pkSpeech: PkSpeechNode,
    pkVote: PkVoteNode,
    wolfExplode: WolfExplodeNode,
  ) {
    this.registry = new NodeRegistry({
      werewolfKill: werewolfKill.create(),
      witchAntidote: witchAntidote.create(),
      witchPoison: witchPoison.create(),
      seerCheck: seerCheck.create(),
      speech: speech.create(),
      vote: vote.create(),
      lastWords: lastWords.create(),
      exileLastWords: exileLastWords.create(),
      sheriffDecideOrder: sheriffDecideOrder.create(),
      pkSpeech: pkSpeech.create(),
      pkVote: pkVote.create(),
      wolfExplode: wolfExplode.create(),
    });
  }
}

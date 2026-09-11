import { Module } from '@nestjs/common';
import { AgentRuntimeModule } from '@/agent-runtime/agent-runtime.module';
import { NodeRegistrar } from '../nodes/node-registrar.service';
import { WerewolfKillNode } from '../nodes/night/werewolf-kill.node';
import { WitchAntidoteNode } from '../nodes/night/witch-antidote.node';
import { WitchPoisonNode } from '../nodes/night/witch-poison.node';
import { SeerCheckNode } from '../nodes/night/seer-check.node';
import { SpeechNode } from '../nodes/day/speech.node';
import { VoteNode } from '../nodes/day/vote.node';
import { LastWordsNode } from '../nodes/day/last-words.node';
import { ExileLastWordsNode } from '../nodes/day/exile-last-words.node';
import { SheriffDecideOrderNode } from '../nodes/day/sheriff-decide-order.node';
import { PkSpeechNode } from '../nodes/day/pk-speech.node';
import { PkVoteNode } from '../nodes/day/pk-vote.node';
import { WolfExplodeNode } from '../nodes/day/wolf-explode.node';

/**
 * 游戏引擎模块
 */
@Module({
  imports: [AgentRuntimeModule],
  providers: [
    NodeRegistrar,
    WerewolfKillNode,
    WitchAntidoteNode,
    WitchPoisonNode,
    SeerCheckNode,
    SpeechNode,
    VoteNode,
    LastWordsNode,
    ExileLastWordsNode,
    SheriffDecideOrderNode,
    PkSpeechNode,
    PkVoteNode,
    WolfExplodeNode,
  ],
  exports: [NodeRegistrar],
})
export class GameEngineModule {}

import { z } from 'zod';

// ===== 玩家信息快照 =====
export const PlayerSnapshotSchema = z.object({
  playerId: z.uuid(),
  seatNo: z.number().int().positive(),
  agentName: z.string(),
  role: z.string().optional(),
  isAlive: z.boolean(),
});

export type PlayerSnapshot = z.infer<typeof PlayerSnapshotSchema>;

// ===== 基础字段 =====
const BaseSSEMessageSchema = z.object({
  gameId: z.uuid(),
  timestamp: z.iso.datetime(),
});

// ===== 1. 连接就绪 =====
export const ConnectionReadySchema = BaseSSEMessageSchema.extend({
  type: z.literal('connection.ready'),
  lastSequence: z.number().int().nonnegative(), // 当前 events 表最大 sequence，0 表示无历史
  players: z.array(PlayerSnapshotSchema), // 完整玩家列表
});

// ===== 2. 游戏流程通知 =====
export const GameAnnouncementSchema = BaseSSEMessageSchema.extend({
  type: z.literal('game.announcement'),
  phase: z.enum(['night', 'day_announce', 'speech', 'vote', 'execute']),
  day: z.number().int().nonnegative(),
  text: z.string(), // "天黑了，狼人请睁眼..."
  subPhase: z.string().optional(), // 'wolfKill' | 'witchAntidote' | ...
});

// ===== 3. LLM 流式 token =====
export const LLMTokenSchema = BaseSSEMessageSchema.extend({
  type: z.literal('llm.token'),
  player: PlayerSnapshotSchema,
  contentType: z.enum(['thinking', 'content']), // 推理链 vs 发言内容
  token: z.string(), // 单个 token
});

// ===== 4. LLM 流式结束（写入 events 表后）=====
export const LLMCompleteSchema = BaseSSEMessageSchema.extend({
  type: z.literal('llm.complete'),
  sequence: z.number().int().positive(), // 写入 events 表后的 sequence
  player: PlayerSnapshotSchema,
  speech: z.string(), // 完整发言
  thinking: z.string().optional(), // 完整推理
});

// ===== 5. 玩家发言（from events 表）=====
export const PlayerSpokeSchema = BaseSSEMessageSchema.extend({
  type: z.literal('player.spoke'),
  sequence: z.number().int().positive(),
  player: PlayerSnapshotSchema,
  speech: z.string(),
  thinking: z.string().optional(),
  isHistorical: z.boolean(),
});

// ===== 6. 玩家投票（from events 表）=====
export const PlayerVotedSchema = BaseSSEMessageSchema.extend({
  type: z.literal('player.voted'),
  sequence: z.number().int().positive(),
  voter: PlayerSnapshotSchema,
  target: PlayerSnapshotSchema,
  isHistorical: z.boolean(),
});

// ===== 7. 玩家死亡（from events 表）=====
export const PlayerDiedSchema = BaseSSEMessageSchema.extend({
  type: z.literal('player.died'),
  sequence: z.number().int().positive(),
  player: PlayerSnapshotSchema,
  cause: z.enum(['night_kill', 'execution', 'witch_poison', 'hunter_shot']),
  isHistorical: z.boolean(),
});

// ===== 8. 游戏结束（from events 表）=====
export const GameFinishedSchema = BaseSSEMessageSchema.extend({
  type: z.literal('game.finished'),
  sequence: z.number().int().positive(),
  winnerFaction: z.enum(['villager', 'werewolf', 'third_party']),
  totalDays: z.number().int().positive(),
  isHistorical: z.boolean(),
});

// ===== 9. 游戏状态变化 =====
export const GameStatusChangedSchema = BaseSSEMessageSchema.extend({
  type: z.literal('game.status'),
  status: z.enum(['running', 'paused', 'aborted', 'finished']),
});

// ===== 10. 预言家查验结果 =====
export const SeerCheckResultSchema = BaseSSEMessageSchema.extend({
  type: z.literal('night.seer_check'),
  sequence: z.number().int().positive(),
  day: z.number().int().nonnegative(),
  seer: PlayerSnapshotSchema,
  targetSeatNo: z.number().int().positive(),
  result: z.enum(['good', 'werewolf']),
  thinking: z.string().optional(),
  isHistorical: z.boolean(),
});

// ===== 11. 狼人刀人目标 =====
export const WolfKillTargetSchema = BaseSSEMessageSchema.extend({
  type: z.literal('night.wolf_kill'),
  sequence: z.number().int().positive(),
  day: z.number().int().nonnegative(),
  targetSeatNo: z.number().int().positive().optional(), // 空刀时无 target
  isHistorical: z.boolean(),
});

// ===== 12. 女巫解药 =====
export const WitchAntidoteSchema = BaseSSEMessageSchema.extend({
  type: z.literal('night.witch_antidote'),
  sequence: z.number().int().positive(),
  day: z.number().int().nonnegative(),
  witch: PlayerSnapshotSchema,
  targetSeatNo: z.number().int().positive(), // 0 表示未使用
  saved: z.boolean(),
  thinking: z.string().optional(),
  isHistorical: z.boolean(),
});

// ===== 13. 女巫毒药 =====
export const WitchPoisonSchema = BaseSSEMessageSchema.extend({
  type: z.literal('night.witch_poison'),
  sequence: z.number().int().positive(),
  day: z.number().int().nonnegative(),
  witch: PlayerSnapshotSchema,
  targetSeatNo: z.number().int().positive(), // 0 表示未使用
  used: z.boolean(),
  thinking: z.string().optional(),
  isHistorical: z.boolean(),
});

// ===== 14. 心跳 =====
export const HeartbeatSchema = BaseSSEMessageSchema.extend({
  type: z.literal('heartbeat'),
});

// ===== 联合类型=====
export const SSEMessageSchema = z.discriminatedUnion('type', [
  ConnectionReadySchema,
  GameAnnouncementSchema,
  LLMTokenSchema,
  LLMCompleteSchema,
  PlayerSpokeSchema,
  PlayerVotedSchema,
  PlayerDiedSchema,
  GameFinishedSchema,
  GameStatusChangedSchema,
  SeerCheckResultSchema,
  WolfKillTargetSchema,
  WitchAntidoteSchema,
  WitchPoisonSchema,
  HeartbeatSchema,
]);

export type SSEMessage = z.infer<typeof SSEMessageSchema>;
export type ConnectionReady = z.infer<typeof ConnectionReadySchema>;
export type GameAnnouncement = z.infer<typeof GameAnnouncementSchema>;
export type LLMToken = z.infer<typeof LLMTokenSchema>;
export type LLMComplete = z.infer<typeof LLMCompleteSchema>;
export type PlayerSpoke = z.infer<typeof PlayerSpokeSchema>;
export type PlayerVoted = z.infer<typeof PlayerVotedSchema>;
export type PlayerDied = z.infer<typeof PlayerDiedSchema>;
export type GameFinished = z.infer<typeof GameFinishedSchema>;
export type GameStatusChanged = z.infer<typeof GameStatusChangedSchema>;
export type SeerCheckResult = z.infer<typeof SeerCheckResultSchema>;
export type WolfKillTarget = z.infer<typeof WolfKillTargetSchema>;
export type WitchAntidote = z.infer<typeof WitchAntidoteSchema>;
export type WitchPoison = z.infer<typeof WitchPoisonSchema>;
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

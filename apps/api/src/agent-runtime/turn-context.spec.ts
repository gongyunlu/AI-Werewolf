import { buildTurnContext } from './turn-context';
import { getHistoricallyVisibleEvents } from '../game-engine/rules/visibility';
const roster = Array.from({ length: 6 }, (_, index) => ({
  seatNo: index + 1,
  displayName: `玩家${index + 1}`,
}));
const event = (
  sequence: number,
  actorId: string,
  seatNo: number,
  speech: string,
  visibility = 'public',
) => ({
  sequence,
  actorId,
  day: 2,
  actionType: 'speech',
  visibility,
  content: { seatNo, speech },
});

it('为可见票型提供事件依据，不复制私有推理，也不凭自爆字样补造跳过阶段', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'vote',
    position: { day: 2, phase: 'PK投票', round: 1, aliveSeats: [1, 6] },
    events: [
      {
        sequence: 31,
        day: 2,
        phase: 'vote',
        actionType: 'vote',
        visibility: 'public',
        content: { voterSeatNo: 6, targetSeatNo: 1, voteRound: 0, thinking: '私密分析不得复制' },
      },
      {
        sequence: 32,
        day: 2,
        phase: 'day_announce',
        actionType: 'judge_announce',
        visibility: 'public',
        content: { content: '无人自爆，开始发言。' },
      },
    ],
  });
  expect(text).toContain('第0轮投票：6号投给1号');
  expect(text).toContain('无人自爆，开始发言');
  expect(text).not.toContain('私密分析');
  expect(text).not.toContain('发言与投票阶段未执行');
});

it('保留自己的假跳原话，区分公开声明与真实查验，并排除狼队私聊', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'speech',
    events: getHistoricallyVisibleEvents({ id: 'p1', role: 'villager', deathDay: null }, [
      event(30, 'p1', 1, '首夜验4号金水，第二夜6号查杀'),
      event(35, 'p2', 2, '狼队暗号', 'wolf'),
    ]),
    position: {
      day: 2,
      aliveSeats: [1, 6],
      phase: 'PK发言',
      round: 1,
      order: [1, 6],
      completedSeats: [],
    },
  });
  expect(text).toContain('你本人1号发言原文：首夜验4号金水');
  expect(text).toContain('不代表真实身份或真实查验');
  expect(text).not.toContain('狼队暗号');
});

it('6号发言前区分已完成、未轮到、失败跳过', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p6',
    seatNo: 6,
    actionType: 'speech',
    events: [],
    position: {
      day: 2,
      aliveSeats: [1, 3, 4, 6],
      phase: '普通发言',
      round: 0,
      order: [3, 4, 6, 1],
      completedSeats: [3],
      skippedSeats: [4],
    },
  });
  expect(text).toContain('本轮已完成发言：3');
  expect(text).toContain('本轮因失败或跳过而未完成：4');
  expect(text).toContain('你之后尚未轮到：1');
  expect(text).toContain('尚未轮到不代表沉默');
});

it('历史公开发言保留实际窗口与轮次，不把 PK 原话标成普通发言', () => {
  const record = event(40, 'p1', 1, '这一轮PK我改变看法');
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'speech',
    position: { day: 3, phase: '普通发言', round: 0, aliveSeats: [1, 6] },
    events: [
      {
        ...record,
        phase: 'speech',
        content: { ...record.content, turn: { phase: 'PK发言', round: 1 } },
      },
    ],
  });
  expect(text).toContain('事件#40 第2天 PK发言 [public]：你本人1号发言原文（第1轮）');
});

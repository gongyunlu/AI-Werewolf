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
  id: `e${sequence}`,
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
        id: 'e31',
        sequence: 31,
        day: 2,
        phase: 'vote',
        actionType: 'vote',
        visibility: 'public',
        content: { voterSeatNo: 6, targetSeatNo: 1, voteRound: 0, thinking: '私密分析不得复制' },
      },
      {
        id: 'e32',
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

it('只投影本人当时的私有理由，不复制他人 thinking', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'speech',
    position: { day: 2, phase: '普通发言', round: 0, aliveSeats: [1, 2] },
    events: [
      {
        ...event(50, 'p1', 1, '我倾向先听2号'),
        content: { seatNo: 1, speech: '我倾向先听2号', thinking: '我怀疑2号但今天不打算跳' },
      },
      {
        ...event(51, 'p2', 2, '我觉得1号很急'),
        content: { seatNo: 2, speech: '我觉得1号很急', thinking: '我是狼，先给1号压力' },
      },
    ],
  });
  expect(text).toContain('[你的私有理由·当时] 我怀疑2号但今天不打算跳');
  expect(text).not.toContain('我是狼，先给1号压力');
  expect(text).toContain('只代表你当时提交动作时的判断和策略，不是当前事实');
});

it('投票等未写 thinking 的本人动作按事件 id 补充当时理由', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'speech',
    position: { day: 2, phase: '普通发言', round: 0, aliveSeats: [1, 2] },
    events: [
      {
        id: 'e60',
        sequence: 60,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        visibility: 'public',
        actorId: 'p1',
        content: { voterSeatNo: 1, targetSeatNo: 2, voteRound: 0 },
      },
      {
        id: 'e61',
        sequence: 61,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        visibility: 'public',
        actorId: 'p2',
        content: { voterSeatNo: 2, targetSeatNo: 1, voteRound: 0 },
      },
    ],
    ownReasonings: new Map([
      ['e60', '2号首夜刀口发言回避，先归票他'],
      ['e61', '不应出现在这里'],
    ]),
  });
  expect(text).toContain('第0轮投票：1号投给2号');
  expect(text).toContain('[你的私有理由·当时] 2号首夜刀口发言回避，先归票他');
  expect(text).not.toContain('不应出现在这里');
});

it('本人事件没有保存理由时不补造', () => {
  const text = buildTurnContext({
    roster,
    playerId: 'p1',
    seatNo: 1,
    actionType: 'speech',
    position: { day: 2, phase: '普通发言', round: 0, aliveSeats: [1, 2] },
    events: [
      {
        id: 'e70',
        sequence: 70,
        day: 1,
        phase: 'vote',
        actionType: 'vote',
        visibility: 'public',
        actorId: 'p1',
        content: { voterSeatNo: 1, targetSeatNo: 2, voteRound: 0 },
      },
    ],
  });
  expect(text).toContain('第0轮投票：1号投给2号');
  expect(text).not.toContain('[你的私有理由·当时]');
});

import { pairedWolfOrder } from './werewolf-collaboration';

it('配对讨论顺序只由 pair/day/round/seat 决定，不受输入顺序及玩家 UUID 影响', () => {
  const on = [
    { id: 'on-2', seatNo: 2 },
    { id: 'on-6', seatNo: 6 },
  ];
  const off = [
    { id: 'off-6', seatNo: 6 },
    { id: 'off-2', seatNo: 2 },
  ];
  const random = jest.spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('unpaired randomness');
  });
  try {
    for (const day of [1, 2])
      for (const round of [0, 1]) {
        expect(pairedWolfOrder(on, 'pair', day, round).map((p) => p.seatNo)).toEqual(
          pairedWolfOrder(off, 'pair', day, round).map((p) => p.seatNo),
        );
      }
    expect(on.map((p) => p.seatNo)).toEqual([2, 6]);
  } finally {
    random.mockRestore();
  }
});

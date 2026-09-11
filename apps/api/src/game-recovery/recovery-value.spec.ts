import { decodeRecoveryValue, encodeRecoveryValue } from './recovery-value';

/** Include the JSON boundary used by PostgreSQL rather than passing encoder objects directly. */
function roundTrip<T>(value: T): T {
  return decodeRecoveryValue<T>(JSON.parse(JSON.stringify(encodeRecoveryValue(value))));
}

describe('recovery values', () => {
  it('preserves nested game Maps, insertion order and Date values after JSON storage', () => {
    const state = {
      players: new Map([
        ['seat-2', { alive: false, votedFor: undefined }],
        ['seat-1', { alive: true, votedFor: 'seat-2' }],
      ]),
      votes: new Map([[2, new Map([['seat-1', 'seat-2']])]]),
      startedAt: new Date('2026-09-10T01:02:03.456Z'),
    };

    const recovered = roundTrip(state);
    expect([...recovered.players.keys()]).toEqual(['seat-2', 'seat-1']);
    expect(recovered.players.get('seat-2')).toEqual({ alive: false, votedFor: undefined });
    expect(recovered.votes.get(2)?.get('seat-1')).toBe('seat-2');
    expect(recovered.startedAt).toBeInstanceOf(Date);
    expect(recovered.startedAt.toISOString()).toBe('2026-09-10T01:02:03.456Z');
    expect(recovered).toEqual(state);
  });

  it('does not reinterpret model JSON fields as serialization tags', () => {
    const modelOutput = {
      type: 'map',
      value: [['player', { type: 'date', value: 'this is model text' }]],
      nested: { type: 'undefined', value: 0, ok: false },
      choices: [null, false, 0, '', { type: 'unknown', value: [] }],
    };
    expect(roundTrip(modelOutput)).toEqual(modelOutput);
  });

  it('preserves an own __proto__ JSON field without changing the object prototype', () => {
    const modelOutput = JSON.parse('{"__proto__":{"polluted":true},"constructor":"model"}');
    const recovered = roundTrip(modelOutput);
    expect(Object.hasOwn(recovered, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(recovered)).toBe(Object.prototype);
    expect(recovered).toEqual(modelOutput);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it.each([undefined, null, true, false, 0, -12.5, '', '狼人 🐺'])(
    'round-trips scalar %p',
    (value) => {
      expect(roundTrip(value)).toBe(value);
    },
  );

  it('retains explicit undefined properties and array entries', () => {
    const recovered = roundTrip({ missing: undefined, entries: [undefined, null] });
    expect(Object.hasOwn(recovered, 'missing')).toBe(true);
    expect(recovered.entries).toHaveLength(2);
    expect(recovered.entries[0]).toBeUndefined();
    expect(recovered.entries[1]).toBeNull();
  });

  it('rejects unsupported stored type tags', () => {
    expect(() => decodeRecoveryValue({ type: 'future-version', value: 'x' })).toThrow();
  });
});

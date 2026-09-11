import type { Prisma } from '../generated/prisma/client';

type Encoded = { type: string; value?: unknown };

function encode(item: unknown): Encoded {
  if (item === undefined) return { type: 'undefined' };
  if (item instanceof Date) return { type: 'date', value: item.toISOString() };
  if (item instanceof Map)
    return { type: 'map', value: [...item].map(([key, val]) => [encode(key), encode(val)]) };
  if (Array.isArray(item)) return { type: 'array', value: item.map(encode) };
  if (item !== null && typeof item === 'object')
    return { type: 'object', value: Object.entries(item).map(([key, val]) => [key, encode(val)]) };
  return { type: 'scalar', value: item };
}

/** 执行记录包含 Map 和日期；使用显式类型封装，避免与模型返回的对象字段冲突。 */
export function encodeRecoveryValue(value: unknown): Prisma.InputJsonValue {
  return encode(value) as Prisma.InputJsonValue;
}

export function decodeRecoveryValue<T>(value: unknown): T {
  const decode = (item: Encoded): unknown => {
    switch (item.type) {
      case 'undefined':
        return undefined;
      case 'date':
        return new Date(item.value as string);
      case 'map':
        return new Map(
          (item.value as [Encoded, Encoded][]).map(([k, v]) => [decode(k), decode(v)]),
        );
      case 'array':
        return (item.value as Encoded[]).map(decode);
      case 'object':
        return Object.fromEntries(
          (item.value as [string, Encoded][]).map(([k, v]) => [k, decode(v)]),
        );
      case 'scalar':
        return item.value;
      default:
        throw new Error('执行检查点包含不支持的值类型');
    }
  };
  return decode(value as Encoded) as T;
}

/** 数据库 JSONB 不保留对象键顺序；协议字符串按键排序，数组顺序仍有业务含义。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : item,
  );
}

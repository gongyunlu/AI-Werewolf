/** 仅去掉包裹整个 JSON 的代码围栏；不提取片段、不补括号、不修复字段。 */
export function parseJsonOutput(content: string, allowCodeFence = false): unknown {
  const fenced = allowCodeFence
    ? /^```(?:json)?[\t ]*\r?\n([\s\S]*)\r?\n```$/i.exec(content.trim())
    : null;
  return JSON.parse(fenced ? fenced[1] : content);
}

import { parseJsonOutput } from './parse-json-output';

it.each([
  '{"issues":[]}',
  '```json\n{"issues":[]}\n```',
  ' \r\n```JSON\r\n{"issues":[]}\r\n```\r\n',
  '```\n{"issues":[]}\n```',
])('完整 JSON 或完整围栏保持原始字段值：%s', (content) => {
  expect(parseJsonOutput(content, true)).toEqual({ issues: [] });
});

it.each([
  '答案：```json\n{"issues":[]}\n```',
  '```json\n{"issues":[]}\n```\n补充解释',
  '```json\n{"issues":[]}\n```\n```json\n{}\n```',
  '```json\n{"issues":[]\n```',
  '```json\n{"issues":[]}',
  '{"issues":[]',
  '<json>{"issues":[]}</json>',
])('不修复或提取残缺及混杂输出：%s', (content) => {
  expect(() => parseJsonOutput(content, true)).toThrow(SyntaxError);
});

it('其他协议继续拒绝代码围栏，正常 JSON 字符串中的反引号保持原文', () => {
  expect(() => parseJsonOutput('```json\n{}\n```')).toThrow(SyntaxError);
  expect(parseJsonOutput('{"content":"```json\\n保持原文\\n```"}', true)).toEqual({
    content: '```json\n保持原文\n```',
  });
});

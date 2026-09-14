import { decryptAgentSecret, encryptAgentSecret } from './agent-secret';

const SECRET_KEY = 'a'.repeat(64);

describe('Agent 自带密钥的加解密', () => {
  it('往返还原明文，且密文里不含明文片段', () => {
    const payload = encryptAgentSecret('sk-plain-key-1234', SECRET_KEY);
    expect(payload).not.toContain('sk-plain-key-1234');
    expect(payload.startsWith('v1.')).toBe(true);
    expect(decryptAgentSecret(payload, SECRET_KEY)).toBe('sk-plain-key-1234');
  });

  it('同一明文两次加密得到不同密文', () => {
    expect(encryptAgentSecret('sk-plain-key', SECRET_KEY)).not.toBe(
      encryptAgentSecret('sk-plain-key', SECRET_KEY),
    );
  });

  it('换主密钥后解不开旧密文', () => {
    const payload = encryptAgentSecret('sk-plain-key', SECRET_KEY);
    expect(() => decryptAgentSecret(payload, 'b'.repeat(64))).toThrow();
  });

  it('密文被篡改时认证失败并抛错，不返回半截明文', () => {
    const [prefix, iv, tag, body] = encryptAgentSecret('sk-plain-key', SECRET_KEY).split('.');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] ^= 0xff;
    expect(() =>
      decryptAgentSecret([prefix, iv, tag, flipped.toString('base64')].join('.'), SECRET_KEY),
    ).toThrow();
  });

  it.each(['', 'not-a-key', 'a'.repeat(63)])('主密钥格式非法时拒绝加解密：%s', (badKey) => {
    expect(() => encryptAgentSecret('sk-plain-key', badKey)).toThrow('AGENT_SECRET_KEY');
    expect(() => decryptAgentSecret('v1.x.y.z', badKey)).toThrow();
  });

  it('密文结构不完整时直接拒绝', () => {
    expect(() => decryptAgentSecret('v2.a.b.c', SECRET_KEY)).toThrow('格式无效');
    expect(() => decryptAgentSecret('v1.a.b', SECRET_KEY)).toThrow('格式无效');
  });
});

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1';

/**
 * 解析 AGENT_SECRET_KEY：接受 64 位十六进制或 base64 编码的 32 字节密钥。
 * 长度不符时直接抛错，避免用派生出来的弱密钥静默加密。
 */
function parseKey(secretKey: string): Buffer {
  const trimmed = secretKey.trim();
  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (key.length !== 32) {
    throw new Error('AGENT_SECRET_KEY 必须是 32 字节密钥（64 位十六进制或 base64 编码）');
  }
  return key;
}

/** 加密 Agent 自带密钥；结果形如 `v1.<iv>.<tag>.<密文>`，各段均为 base64。 */
export function encryptAgentSecret(plaintext: string, secretKey: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, parseKey(secretKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

/** 解密 Agent 自带密钥；密文被篡改或密钥更换时认证失败并抛错。 */
export function decryptAgentSecret(payload: string, secretKey: string): string {
  const [prefix, iv, tag, ciphertext] = payload.split('.');
  if (prefix !== PREFIX || !iv || !tag || !ciphertext) {
    throw new Error('Agent 密钥密文格式无效');
  }
  const ivBuffer = Buffer.from(iv, 'base64');
  const tagBuffer = Buffer.from(tag, 'base64');
  if (ivBuffer.length !== IV_BYTES || tagBuffer.length !== TAG_BYTES) {
    throw new Error('Agent 密钥密文格式无效');
  }
  const decipher = createDecipheriv(ALGORITHM, parseKey(secretKey), ivBuffer);
  decipher.setAuthTag(tagBuffer);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    // crypto 只说认证失败，这里补上运维需要的判断：多半是 AGENT_SECRET_KEY 被换过
    throw new Error('Agent 密钥解密失败：AGENT_SECRET_KEY 与加密时不一致，或密文被篡改', {
      cause: error,
    });
  }
}

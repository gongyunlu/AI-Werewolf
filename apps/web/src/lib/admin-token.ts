const STORAGE_KEY = 'ai-werewolf:admin-token';

/**
 * 管理写接口的令牌：只存在本机浏览器里，随写请求带 x-admin-token 头。
 * 读接口不需要它，所以观战与开局在未填令牌时也能正常用。
 */
let token = readInitialToken();

function readInitialToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // 隐私模式等场景下 localStorage 不可用，退化为仅本次会话有效
    return '';
  }
}

export function getAdminToken(): string {
  return token;
}

export function setAdminToken(value: string): void {
  token = value.trim();
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 存储不可用时不影响本次会话内使用
  }
}

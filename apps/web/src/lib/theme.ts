const STORAGE_KEY = 'ai-werewolf:theme';
const DAY_CLASS = 'day';

export type Theme = 'night' | 'day';

/**
 * 昼夜主题：默认夜晚，白天由 `<html>` 上的 .day 类切换，index.css 里两套 token 各自取值。
 * 类名直接挂在 documentElement 上，shadcn 组件与页面模块 CSS 都能读到。
 */
export function applyStoredTheme(): void {
  document.documentElement.classList.toggle(DAY_CLASS, readStoredTheme() === 'day');
}

export function currentTheme(): Theme {
  return document.documentElement.classList.contains(DAY_CLASS) ? 'day' : 'night';
}

export function setTheme(theme: Theme): void {
  document.documentElement.classList.toggle(DAY_CLASS, theme === 'day');
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // 存储不可用时只在本次会话内生效
  }
}

function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // 隐私模式等场景下 localStorage 不可用，退化为默认的夜晚主题
    return null;
  }
}

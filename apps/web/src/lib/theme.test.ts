import { beforeEach, describe, expect, it } from 'vitest';
import { applyStoredTheme, currentTheme, setTheme } from './theme';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.className = '';
});

describe('昼夜主题', () => {
  it('没有存过选择时是夜晚', () => {
    applyStoredTheme();

    expect(currentTheme()).toBe('night');
    expect(document.documentElement.classList.contains('day')).toBe(false);
  });

  it('切到白天后重新加载仍是白天，切回夜晚同样保留', () => {
    setTheme('day');
    expect(document.documentElement.classList.contains('day')).toBe(true);
    expect(localStorage.getItem('ai-werewolf:theme')).toBe('day');

    document.documentElement.className = '';
    applyStoredTheme();
    expect(currentTheme()).toBe('day');

    setTheme('night');
    document.documentElement.className = '';
    applyStoredTheme();
    expect(currentTheme()).toBe('night');
  });
});

import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from './ui/button';
import { currentTheme, setTheme } from '../lib/theme';

/**
 * 顶栏的昼夜切换按钮。
 *
 * 初始值直接读 documentElement 上的类名而不是 local state，因此放在多个顶栏里也始终一致：
 * 切换是同步改 DOM 的，另一个实例下次挂载时读到的就是新值。
 */
export function ThemeToggle() {
  const [theme, setThemeState] = useState(currentTheme);

  const toggleTheme = () => {
    const next = theme === 'day' ? 'night' : 'day';
    setTheme(next);
    setThemeState(next);
  };

  const label = theme === 'day' ? '切换到夜晚主题' : '切换到白天主题';

  return (
    <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label={label} title={label}>
      {theme === 'day' ? <Moon /> : <Sun />}
    </Button>
  );
}

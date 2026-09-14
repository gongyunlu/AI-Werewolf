import styles from './AppHeader.module.css';
import { Link, useLocation } from 'react-router-dom';
import { ThemeToggle } from './ThemeToggle';

interface AppHeaderProps {
  rightContent?: React.ReactNode;
}

export function AppHeader({ rightContent }: AppHeaderProps) {
  const location = useLocation();

  const isActive = (path: string) => {
    if (path === '/') {
      return location.pathname === '/';
    }
    return location.pathname.startsWith(path);
  };

  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        {/* 左侧：Logo + 导航 */}
        <div className={styles.group}>
          <Link to="/" className={styles.logo}>
            <span className={styles.logoIcon}>🐺</span>
            <span>AI 狼人杀</span>
          </Link>

          <nav className={styles.nav}>
            <Link to="/" className={isActive('/') ? styles.navLinkActive : styles.navLink}>
              首页
            </Link>
            <Link
              to="/games"
              className={isActive('/games') ? styles.navLinkActive : styles.navLink}
            >
              对局列表
            </Link>
            <Link
              to="/agents"
              className={isActive('/agents') ? styles.navLinkActive : styles.navLink}
            >
              Agent 管理
            </Link>
          </nav>
        </div>

        {/* 右侧：昼夜切换 + 自定义内容 */}
        <div className={styles.right}>
          <ThemeToggle />
          {rightContent}
        </div>
      </div>
    </header>
  );
}

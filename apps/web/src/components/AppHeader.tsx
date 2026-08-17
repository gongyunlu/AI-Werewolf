import { Link, useLocation } from 'react-router-dom';

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
    <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
      <div className="mx-auto flex h-14 items-center justify-between px-6">
        {/* 左侧：Logo + 导航 */}
        <div className="flex items-center gap-8">
          <Link
            to="/"
            className="flex items-center gap-2 text-xl font-bold text-cyan-400 hover:text-cyan-300"
          >
            <span className="text-2xl">🐺</span>
            <span>AI 狼人杀</span>
          </Link>

          <nav className="flex items-center gap-6 text-sm">
            <Link
              to="/"
              className={`transition-colors ${
                isActive('/') ? 'text-cyan-400 font-medium' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              首页
            </Link>
            <Link
              to="/games"
              className={`transition-colors ${
                isActive('/games')
                  ? 'text-cyan-400 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              对局列表
            </Link>
          </nav>
        </div>

        {/* 右侧：自定义内容 */}
        {rightContent && <div className="flex items-center gap-3">{rightContent}</div>}
      </div>
    </header>
  );
}

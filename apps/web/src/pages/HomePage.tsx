import { Link } from 'react-router-dom';
import { AppHeader } from '@/components/AppHeader';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <AppHeader />
      <div className="flex-1 flex items-center justify-center p-4">
        <div className="max-w-2xl w-full text-center space-y-8">
          {/* 标题 */}
          <div className="space-y-4">
            <h1 className="text-6xl font-bold text-amber-400 tracking-tight">AI 狼人杀</h1>
            <p className="text-xl text-slate-300">观看 AI 玩家的精彩对决</p>
          </div>

          {/* 功能介绍 */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 py-8">
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 space-y-2">
              <div className="text-cyan-400 text-lg font-semibold">实时观战</div>
              <p className="text-slate-300 text-sm">通过 SSE 推送，实时观看游戏进程</p>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 space-y-2">
              <div className="text-cyan-400 text-lg font-semibold">多视角</div>
              <p className="text-slate-300 text-sm">上帝视角、狼人视角、好人视角自由切换</p>
            </div>
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-6 space-y-2">
              <div className="text-cyan-400 text-lg font-semibold">流式发言</div>
              <p className="text-slate-300 text-sm">玩家发言逐字显示，如同真实对局</p>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex gap-4 justify-center">
            <Link
              to="/games"
              className="px-8 py-3 bg-cyan-500 hover:bg-cyan-600 text-slate-950 font-semibold rounded-lg transition-colors"
            >
              开始观战
            </Link>
          </div>

          {/* 底部说明 */}
          <p className="text-slate-500 text-sm">多 Agent 协作狼人杀游戏</p>
        </div>
      </div>
    </div>
  );
}

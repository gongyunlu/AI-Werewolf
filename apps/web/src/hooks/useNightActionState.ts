import { useEffect, useState } from 'react';
import type { ClosedScene } from './useSceneEngine';

interface NightActionState {
  wolfTarget: number | null; // 被狼刀的玩家座位号
  witchSaved: number | null; // 被女巫救的玩家座位号
}

/**
 * 管理夜间行动状态（狼刀、女巫救人等）
 * 用于在玩家卡片上显示实时状态效果
 */
export function useNightActionState(closedScenes: ClosedScene[]) {
  const [state, setState] = useState<NightActionState>({
    wolfTarget: null,
    witchSaved: null,
  });

  useEffect(() => {
    // 从最新的场景中提取夜间行动信息
    let wolfTarget: number | null = null;
    let witchSaved: number | null = null;

    // 倒序遍历，获取当前夜晚最新的行动状态
    for (let i = closedScenes.length - 1; i >= 0; i--) {
      const scene = closedScenes[i];
      if (!scene.metadata) continue;

      const action = scene.metadata.action as string;

      // 如果遇到天亮事件（死亡公告），清空夜间状态
      if (scene.sceneType === 'judge' && scene.content.includes('出局')) {
        wolfTarget = null;
        witchSaved = null;
        break;
      }

      // 女巫救人（后执行，优先级高）
      if (action === 'witch_save' && witchSaved === null) {
        const saved = scene.metadata.saved as boolean;
        const targetSeatNo = scene.metadata.targetSeatNo as number;
        if (saved && targetSeatNo) {
          witchSaved = targetSeatNo;
        }
      }

      // 狼人刀人
      if (action === 'wolf_kill' && wolfTarget === null) {
        const targetSeatNo = scene.metadata.targetSeatNo as number;
        if (targetSeatNo) {
          wolfTarget = targetSeatNo;
        }
      }
    }

    setState({ wolfTarget, witchSaved });
  }, [closedScenes]);

  return state;
}

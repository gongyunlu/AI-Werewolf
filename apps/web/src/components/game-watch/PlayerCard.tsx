import styles from './PlayerCard.module.css';
import clsx from 'clsx';
import { Crown } from 'lucide-react';

interface Player {
  id: string;
  seatNo: number | null;
  displayName: string;
  role: string | null;
  faction: string | null;
  deathDay: number | null;
  isSheriff?: boolean;
  modelName?: string;
}

interface Props {
  player: Player;
  index: number;
  isLeft: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  werewolf: '狼人',
  guard: '守卫',
};

// 角色文字颜色 class：狼人阵营红色 / 普通村民蓝色 / 神职绿色
type RoleColor = 'roleWolf' | 'roleVillager' | 'roleGod';

function roleColorClass(role: string, faction: string): RoleColor {
  if (faction === 'werewolf' || role === 'werewolf') return 'roleWolf';
  if (role === 'villager') return 'roleVillager';
  return 'roleGod';
}

export function PlayerCard({ player, index, isLeft }: Props) {
  // 未分配座次时，按玩家在数组中的索引占位（index + 1）
  const displaySeatNo = player.seatNo ?? index + 1;
  const roleLabel = (player.role && (ROLE_LABELS[player.role] || player.role)) || '';
  const roleColor = player.role ? roleColorClass(player.role, player.faction ?? '') : '';

  return (
    <div className={clsx(styles.root, !isLeft && styles.rootFlip)}>
      {/* 信息 */}
      <div className={clsx(styles.info, isLeft ? styles.infoLeft : styles.infoRight)}>
        <span className={styles.modelName}>{player.modelName}</span>
        <span className={styles.name}>{player.displayName}</span>
      </div>

      {/* 头像 */}
      <div className={styles.avatarWrap}>
        <div className={styles.avatar} />
        <span className={styles.seatNo}>{displaySeatNo}</span>
        {player.isSheriff && (
          <div className={clsx(styles.sheriff, isLeft ? styles.sheriffLeft : styles.sheriffRight)}>
            <Crown className={styles.crown} fill="currentColor" />
          </div>
        )}
      </div>

      {/* 角色标签：未分配时显示灰色"未分配" */}
      {player.role ? (
        <div className={clsx(styles.role, styles[roleColor])}>{roleLabel}</div>
      ) : (
        <div className={clsx(styles.role, styles.roleUnassigned)}>未分配</div>
      )}
    </div>
  );
}

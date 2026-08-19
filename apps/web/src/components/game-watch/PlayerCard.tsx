import { memo } from 'react';
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
  deathCause: string | null;
  isSheriff?: boolean;
  modelName?: string;
}

interface Props {
  player: Player;
  index: number;
  isLeft: boolean;
  hasWolfMark?: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  villager: '村民',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  werewolf: '狼人',
  guard: '守卫',
};

const DEATH_CAUSE_LABELS: Record<string, string> = {
  night_kill: '刀',
  execution: '放逐',
  hunter_shot: '枪',
  witch_poison: '毒',
};

const DEATH_CAUSE_ICONS: Record<string, string> = {
  night_kill: '🗡️',
  execution: '⚖️',
  hunter_shot: '🔫',
  witch_poison: '☠️',
};

// 角色文字颜色 class：狼人阵营红色 / 普通村民蓝色 / 神职绿色
type RoleColor = 'roleWolf' | 'roleVillager' | 'roleGod';

function roleColorClass(role: string, faction: string): RoleColor {
  if (faction === 'werewolf' || role === 'werewolf') return 'roleWolf';
  if (role === 'villager') return 'roleVillager';
  return 'roleGod';
}

export const PlayerCard = memo(function PlayerCard({ player, index, isLeft, hasWolfMark }: Props) {
  // 未分配座次时，按玩家在数组中的索引占位（index + 1）
  const displaySeatNo = player.seatNo ?? index + 1;
  const roleLabel = (player.role && (ROLE_LABELS[player.role] || player.role)) || '';
  const roleColor = player.role ? roleColorClass(player.role, player.faction ?? '') : '';
  const isDead = player.deathDay !== null;
  const deathCauseLabel = player.deathCause ? DEATH_CAUSE_LABELS[player.deathCause] : '';
  const deathCauseIcon = player.deathCause ? DEATH_CAUSE_ICONS[player.deathCause] : '';

  return (
    <div className={clsx(styles.root, !isLeft && styles.rootFlip, isDead && styles.dead)}>
      {/* 信息 */}
      <div className={clsx(styles.info, isLeft ? styles.infoLeft : styles.infoRight)}>
        <span className={styles.modelName}>{player.modelName}</span>
        <span className={styles.name}>{player.displayName}</span>
      </div>

      {/* 头像 */}
      <div className={styles.avatarWrap}>
        <div className={clsx(styles.avatar, isDead && styles.avatarDead)} />
        <span className={styles.seatNo}>{displaySeatNo}</span>
        {player.isSheriff && (
          <div className={clsx(styles.sheriff, isLeft ? styles.sheriffLeft : styles.sheriffRight)}>
            <Crown className={styles.crown} fill="currentColor" />
          </div>
        )}
        {/* 狼人刀痕标记 */}
        {hasWolfMark && !isDead && (
          <div className={styles.wolfMark} title="被狼人刀中">
            🩸
          </div>
        )}
        {/* 死亡标记 */}
        {isDead && (
          <div className={styles.deathMark} title={deathCauseLabel}>
            {deathCauseIcon}
          </div>
        )}
      </div>

      {/* 角色标签：未分配时显示灰色"未分配" */}
      {player.role ? (
        <div className={clsx(styles.role, styles[roleColor], isDead && styles.roleDead)}>
          {roleLabel}
        </div>
      ) : (
        <div className={clsx(styles.role, styles.roleUnassigned)}>未分配</div>
      )}
    </div>
  );
});

import styles from './PlayerPanel.module.css';
import clsx from 'clsx';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Heart, Skull } from 'lucide-react';

interface Player {
  seatNo: number;
  displayName: string;
  role?: string;
  faction?: string;
  deathDay: number | null;
}

interface Props {
  players: Player[];
}

export function PlayerPanel({ players }: Props) {
  return (
    <div className={styles.grid}>
      {players.map((player) => {
        const isAlive = player.deathDay === null;
        return (
          <Card
            key={player.seatNo}
            size="sm"
            className={clsx(isAlive ? styles.cardAlive : styles.cardDead)}
          >
            <CardContent className={styles.content}>
              <div className={styles.header}>
                <span>#{player.seatNo}</span>
                <Badge variant={isAlive ? 'default' : 'secondary'} className={styles.badge}>
                  {isAlive ? (
                    <>
                      <Heart className={styles.icon} />
                      存活
                    </>
                  ) : (
                    <>
                      <Skull className={styles.icon} />
                      死亡
                    </>
                  )}
                </Badge>
              </div>
              <div className={styles.playerName}>{player.displayName}</div>
              {player.role && player.faction && (
                <div className={styles.roleInfo}>
                  {player.role} · {player.faction}
                </div>
              )}
            </CardContent>
            {!isAlive && <div className={styles.deadOverlay} />}
          </Card>
        );
      })}
    </div>
  );
}

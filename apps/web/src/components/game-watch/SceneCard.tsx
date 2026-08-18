import styles from './SceneCard.module.css';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SceneType } from '@/types/sse';
import { Streamdown } from 'streamdown';

interface Props {
  sceneId: string;
  sceneType: SceneType;
  actorId?: string;
  fullContent: string;
  durationMs: number;
}

const SCENE_TYPE_LABELS: Record<SceneType, string> = {
  system: '系统',
  judge: '法官',
  night_prompt: '夜间引导',
  speech: '发言',
  vote: '投票',
  night_action: '夜间行动',
  last_words: '遗言',
};

const SCENE_TYPE_VARIANTS: Record<SceneType, 'default' | 'secondary' | 'outline'> = {
  system: 'outline',
  judge: 'default',
  night_prompt: 'secondary',
  speech: 'default',
  vote: 'default',
  night_action: 'secondary',
  last_words: 'outline',
};

export function SceneCard({ sceneType, actorId, fullContent, durationMs }: Props) {
  return (
    <Card size="sm" className={styles.card}>
      <CardHeader>
        <div className={styles.header}>
          <Badge variant={SCENE_TYPE_VARIANTS[sceneType]}>{SCENE_TYPE_LABELS[sceneType]}</Badge>
          {actorId && <span className={styles.actorId}>{actorId}</span>}
          <span className={styles.duration}>{(durationMs / 1000).toFixed(1)}s</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className={styles.content}>
          <Streamdown>{fullContent}</Streamdown>
        </div>
      </CardContent>
    </Card>
  );
}

import styles from './ActiveSceneCard.module.css';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SceneType } from '@/types/sse';
import { Streamdown } from 'streamdown';

interface Props {
  sceneType: SceneType;
  actorId?: string;
  displayText: string;
  isTyping?: boolean;
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

export function ActiveSceneCard({ sceneType, actorId, displayText, isTyping = true }: Props) {
  return (
    <Card size="sm" className={styles.card}>
      <CardHeader>
        <div className={styles.header}>
          <Badge variant="default">{SCENE_TYPE_LABELS[sceneType]}</Badge>
          {actorId && <span className={styles.actorId}>{actorId}</span>}
          {isTyping && <span className={styles.typing}>正在输入...</span>}
        </div>
      </CardHeader>
      <CardContent>
        <div className={styles.content}>
          <Streamdown>{displayText}</Streamdown>
          {isTyping && <span className={styles.caret} />}
        </div>
      </CardContent>
    </Card>
  );
}

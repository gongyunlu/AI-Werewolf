import { memo } from 'react';
import styles from './ActiveSceneCard.module.css';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SceneType } from '@/types/sse';
import { ThinkingBlock } from './ThinkingBlock';
import { Streamdown } from 'streamdown';

interface Props {
  sceneType: SceneType;
  actorId?: string;
  actorName?: string;
  actorSeatNo?: number;
  thinking: string;
  content: string;
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

export const ActiveSceneCard = memo(function ActiveSceneCard({
  sceneType,
  actorId,
  actorName,
  actorSeatNo,
  thinking,
  content,
  isTyping = true,
}: Props) {
  return (
    <Card size="sm" className={styles.card}>
      <CardHeader>
        <div className={styles.header}>
          <Badge variant="default">{SCENE_TYPE_LABELS[sceneType]}</Badge>
          {actorId && actorSeatNo !== undefined && actorName && (
            <span className={styles.actorId}>
              {actorSeatNo}号 {actorName}
            </span>
          )}
          {isTyping && <span className={styles.typing}>正在输入...</span>}
        </div>
      </CardHeader>
      <CardContent>
        {thinking && <ThinkingBlock thinking={thinking} defaultOpen />}
        <div className={styles.content}>
          <Streamdown>{content}</Streamdown>
          {isTyping && <span className={styles.caret} />}
        </div>
      </CardContent>
    </Card>
  );
});

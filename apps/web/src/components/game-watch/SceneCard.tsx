import { memo } from 'react';
import styles from './SceneCard.module.css';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { SceneType } from '@/types/sse';
import { ThinkingBlock } from './ThinkingBlock';
import { Streamdown } from 'streamdown';

interface Props {
  sceneId: string;
  sceneType: SceneType;
  actorId?: string;
  actorName?: string;
  actorSeatNo?: number;
  thinking: string;
  content: string;
  thinkingDurationMs: number;
  contentDurationMs: number;
  metadata?: Record<string, unknown>;
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

export const SceneCard = memo(function SceneCard({
  sceneType,
  actorId,
  actorName,
  actorSeatNo,
  thinking,
  content,
  thinkingDurationMs,
  contentDurationMs,
  metadata,
}: Props) {
  // 如果是投票场景，从 metadata 中提取投票信息
  const isVote = sceneType === 'vote' && metadata?.action === 'vote';
  const voterSeatNo = isVote ? (metadata?.voterSeatNo as number) : undefined;
  const targetSeatNo = isVote ? (metadata?.targetSeatNo as number) : undefined;

  return (
    <Card size="sm" className={styles.card}>
      <CardHeader>
        <div className={styles.header}>
          <Badge variant={SCENE_TYPE_VARIANTS[sceneType]}>{SCENE_TYPE_LABELS[sceneType]}</Badge>
          {actorId && actorSeatNo !== undefined && actorName && (
            <span className={styles.actorId}>
              {actorSeatNo}号 {actorName}
            </span>
          )}
          {isVote && voterSeatNo !== undefined && (
            <span className={styles.voteInfo}>
              {voterSeatNo}号 → {targetSeatNo && targetSeatNo !== 0 ? `${targetSeatNo}号` : '弃票'}
            </span>
          )}
          {contentDurationMs > 0 && (
            <span className={styles.duration}>{(contentDurationMs / 1000).toFixed(1)}s</span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {thinking && <ThinkingBlock thinking={thinking} duration={thinkingDurationMs} />}
        <div className={styles.content}>
          <Streamdown>{content}</Streamdown>
        </div>
      </CardContent>
    </Card>
  );
});

import styles from './HomePage.module.css';
import { Link } from 'react-router-dom';
import { AppHeader } from '@/components/AppHeader';

export default function HomePage() {
  return (
    <div className={styles.page}>
      <AppHeader />
      <div className={styles.body}>
        <div className={styles.container}>
          {/* 标题 */}
          <div className={styles.titleBlock}>
            <h1 className={styles.heading}>AI 狼人杀</h1>
            <p className={styles.tagline}>观看 AI 玩家的精彩对决</p>
          </div>

          {/* 功能介绍 */}
          <div className={styles.features}>
            <div className={styles.feature}>
              <div className={styles.featureTitle}>实时观战</div>
              <p className={styles.featureDesc}>通过 SSE 推送，实时观看游戏进程</p>
            </div>
            <div className={styles.feature}>
              <div className={styles.featureTitle}>多视角</div>
              <p className={styles.featureDesc}>上帝视角、狼人视角、好人视角自由切换</p>
            </div>
            <div className={styles.feature}>
              <div className={styles.featureTitle}>流式发言</div>
              <p className={styles.featureDesc}>玩家发言逐字显示，如同真实对局</p>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className={styles.actions}>
            <Link to="/games" className={styles.cta}>
              开始观战
            </Link>
          </div>

          {/* 底部说明 */}
          <p className={styles.footerNote}>多 Agent 协作狼人杀游戏</p>
        </div>
      </div>
    </div>
  );
}

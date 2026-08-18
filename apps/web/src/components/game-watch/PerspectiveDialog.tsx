import styles from './PerspectiveDialog.module.css';
import clsx from 'clsx';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';

const PERSPECTIVES = [
  {
    value: 'god',
    label: '上帝视角',
    description: '查看所有玩家的行动和信息',
    icon: Eye,
  },
  {
    value: 'villager',
    label: '闭眼视角',
    description: '只能看到公开信息',
    icon: EyeOff,
  },
];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (perspective: string) => void;
  onClose: () => void;
  initial?: string;
}

export function PerspectiveDialog({ open, onOpenChange, onSelect, initial }: Props) {
  const [selected, setSelected] = useState(initial || 'god');

  useEffect(() => {
    if (initial) {
      setSelected(initial);
    }
  }, [initial]);

  const handleConfirm = () => {
    onSelect(selected);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>选择观战视角</DialogTitle>
          <DialogDescription>选择你想要观看游戏的视角</DialogDescription>
        </DialogHeader>

        <div className={styles.list}>
          {PERSPECTIVES.map((perspective) => {
            const Icon = perspective.icon;
            return (
              <Label
                key={perspective.value}
                htmlFor={`perspective-${perspective.value}`}
                className={clsx(
                  styles.option,
                  selected === perspective.value && styles.optionSelected,
                )}
              >
                <input
                  type="radio"
                  id={`perspective-${perspective.value}`}
                  name="perspective"
                  value={perspective.value}
                  checked={selected === perspective.value}
                  onChange={() => setSelected(perspective.value)}
                  className={styles.srOnly}
                />
                <div className={styles.iconWrap}>
                  <Icon className={styles.icon} />
                </div>
                <div className={styles.text}>
                  <div className={styles.label}>{perspective.label}</div>
                  <div className={styles.description}>{perspective.description}</div>
                </div>
              </Label>
            );
          })}
        </div>

        <Button onClick={handleConfirm} className={styles.confirmButton}>
          确认
        </Button>
      </DialogContent>
    </Dialog>
  );
}

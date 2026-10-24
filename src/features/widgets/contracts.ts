import type { ISODateTime } from '@/domain/shared/types';

export interface NextChoreWidgetSnapshot {
  todayChoreNames: readonly string[];
  remainingCount: number;
  updatedAt: ISODateTime;
}

export interface NextChoreWidgetDisplayProps {
  firstChore: string;
  secondChore: string;
  thirdChore: string;
  remainingCount: number;
  updatedAt: ISODateTime;
}

export interface WidgetGateway {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void;
}

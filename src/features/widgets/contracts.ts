import type { EntityId, ISODateTime } from '@/domain/shared/types';

export interface NextChoreWidgetSnapshot {
  choreId: EntityId | null;
  choreName: string;
  dateLabel: string;
  assignmentLabel?: string;
  updatedAt: ISODateTime;
}

export interface WidgetGateway {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void;
}

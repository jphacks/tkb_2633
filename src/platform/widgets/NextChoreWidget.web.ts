import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

export default {
  updateSnapshot(_snapshot: NextChoreWidgetDisplayProps): void {},
  async getTimeline(): Promise<{ date: Date; props: NextChoreWidgetDisplayProps }[]> {
    return [];
  },
};

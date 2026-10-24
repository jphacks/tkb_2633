import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

/** Web fallback for builds that do not include native home-screen extensions. */
const NextChoreWidget = {
  updateSnapshot(_snapshot: NextChoreWidgetDisplayProps): void {},
  async getTimeline(): Promise<{ date: Date; props: NextChoreWidgetDisplayProps }[]> {
    return [];
  },
};

export default NextChoreWidget;

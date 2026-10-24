import type { NextChoreWidgetDisplayProps } from '@/features/widgets/contracts';

/** Web fallback for builds that do not include native home-screen extensions. */
const NextChoreWidget = {
  updateSnapshot(_snapshot: NextChoreWidgetDisplayProps): void {},
};

export default NextChoreWidget;

import type { NextChoreWidgetSnapshot } from '@/features/widgets/contracts';

/** Web fallback for builds that do not include native home-screen extensions. */
const NextChoreWidget = {
  updateSnapshot(_snapshot: NextChoreWidgetSnapshot): void {},
};

export default NextChoreWidget;

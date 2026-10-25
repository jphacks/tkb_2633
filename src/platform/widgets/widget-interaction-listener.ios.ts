import { addUserInteractionListener } from 'expo-widgets';

import type { WidgetUserInteractionEvent, WidgetUserInteractionSubscription } from './widget-interaction-listener.types';

export function addWidgetUserInteractionListener(
  listener: (event: WidgetUserInteractionEvent) => void,
): WidgetUserInteractionSubscription {
  return addUserInteractionListener(listener);
}

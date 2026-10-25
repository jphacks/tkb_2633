import type { WidgetUserInteractionEvent, WidgetUserInteractionSubscription } from './widget-interaction-listener.types';

export function addWidgetUserInteractionListener(
  _listener: (event: WidgetUserInteractionEvent) => void,
): WidgetUserInteractionSubscription {
  return { remove() {} };
}

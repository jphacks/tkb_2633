export interface WidgetUserInteractionEvent {
  source: string;
  target: string;
}

export interface WidgetUserInteractionSubscription {
  remove(): void;
}

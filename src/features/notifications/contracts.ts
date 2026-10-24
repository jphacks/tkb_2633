import type { ISODateTime } from '@/domain/shared/types';

export interface LocalNotificationRequest {
  key: string;
  title: string;
  subtitle?: string;
  body: string;
  fireAt: ISODateTime;
  data?: Record<string, string | number | boolean>;
}

export interface LocalNotificationGateway {
  requestPermission(): Promise<boolean>;
  hasPermission(): Promise<boolean>;
  getScheduledRequests(): Promise<readonly LocalNotificationRequest[]>;
  schedule(request: LocalNotificationRequest): Promise<string>;
  cancel(notificationId: string): Promise<void>;
}

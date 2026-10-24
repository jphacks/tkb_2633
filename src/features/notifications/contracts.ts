import type { ISODateTime } from '@/domain/shared/types';

export interface LocalNotificationRequest {
  key: string;
  title: string;
  body: string;
  fireAt: ISODateTime;
  data?: Record<string, string | number | boolean>;
}

export interface LocalNotificationGateway {
  requestPermission(): Promise<boolean>;
  schedule(request: LocalNotificationRequest): Promise<string>;
  cancel(notificationId: string): Promise<void>;
}

import type { LocalNotificationGateway, LocalNotificationRequest } from '@/features/notifications/contracts';

/** The browser build intentionally does not request permission or schedule notifications. */
export class ExpoLocalNotificationGateway implements LocalNotificationGateway {
  async requestPermission(): Promise<boolean> { return false; }
  async hasPermission(): Promise<boolean> { return false; }
  async getScheduledRequests(): Promise<readonly LocalNotificationRequest[]> { return []; }
  async schedule(_request: LocalNotificationRequest): Promise<string> {
    throw new Error('Notifications are unavailable in the web version');
  }
  async cancel(_notificationId: string): Promise<void> {}
}

export const expoLocalNotificationGateway = new ExpoLocalNotificationGateway();

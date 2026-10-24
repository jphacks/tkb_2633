import * as Notifications from 'expo-notifications';

import type {
  LocalNotificationGateway,
  LocalNotificationRequest,
} from '@/features/notifications/contracts';

export class ExpoLocalNotificationGateway implements LocalNotificationGateway {
  async requestPermission(): Promise<boolean> {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      return true;
    }
    if (!current.canAskAgain) {
      return false;
    }

    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  }

  async schedule(request: LocalNotificationRequest): Promise<string> {
    const fireAt = new Date(request.fireAt);
    if (Number.isNaN(fireAt.getTime())) {
      throw new RangeError(`Invalid notification date: ${request.fireAt}`);
    }

    return Notifications.scheduleNotificationAsync({
      identifier: request.key,
      content: {
        title: request.title,
        body: request.body,
        data: request.data,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    });
  }

  async cancel(notificationId: string): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(notificationId);
  }
}

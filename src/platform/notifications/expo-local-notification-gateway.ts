import {
  AndroidImportance,
  cancelScheduledNotificationAsync,
  getPermissionsAsync,
  requestPermissionsAsync,
  scheduleNotificationAsync,
  setNotificationChannelAsync,
  SchedulableTriggerInputTypes,
} from 'expo-notifications';
import { Platform } from 'react-native';

import type {
  LocalNotificationGateway,
  LocalNotificationRequest,
} from '@/features/notifications/contracts';

export class ExpoLocalNotificationGateway implements LocalNotificationGateway {
  async requestPermission(): Promise<boolean> {
    if (Platform.OS === 'android') {
      await setNotificationChannelAsync('housework-reminders', {
        name: '家事のお知らせ',
        importance: AndroidImportance.DEFAULT,
      });
    }
    const current = await getPermissionsAsync();
    if (current.granted) {
      return true;
    }
    if (!current.canAskAgain) {
      return false;
    }

    const requested = await requestPermissionsAsync();
    return requested.granted;
  }

  async schedule(request: LocalNotificationRequest): Promise<string> {
    const fireAt = new Date(request.fireAt);
    if (Number.isNaN(fireAt.getTime())) {
      throw new RangeError(`Invalid notification date: ${request.fireAt}`);
    }

    return scheduleNotificationAsync({
      identifier: request.key,
      content: {
        title: request.title,
        body: request.body,
        data: request.data,
      },
      trigger: {
        type: SchedulableTriggerInputTypes.DATE,
        date: fireAt,
      },
    });
  }

  async cancel(notificationId: string): Promise<void> {
    await cancelScheduledNotificationAsync(notificationId);
  }
}

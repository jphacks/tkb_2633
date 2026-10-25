import type { CalendarCountColors } from '@/domain/shared/types';

export const DEFAULT_CALENDAR_COUNT_COLORS: CalendarCountColors = {
  low: '#4AADE0',
  medium: '#F2A541',
  high: '#E45B61',
};

export const CALENDAR_COUNT_COLOR_OPTIONS = [
  { name: '青', value: '#4AADE0' },
  { name: '緑', value: '#48A878' },
  { name: '橙', value: '#F2A541' },
  { name: '赤', value: '#E45B61' },
  { name: '紫', value: '#9274D8' },
  { name: '灰', value: '#808AA0' },
] as const;

export function calendarCountColor(count: number, colors: CalendarCountColors): string | null {
  if (count <= 0) return null;
  if (count >= 10) return colors.high;
  if (count >= 6) return colors.medium;
  return colors.low;
}

export function calendarDotCount(count: number): number {
  if (count <= 0) return 0;
  if (count <= 5) return count;
  if (count <= 9) return count - 5;
  return Math.min(count - 9, 5);
}

export function parseCalendarCountColors(value: string | null | undefined): CalendarCountColors {
  if (!value) return DEFAULT_CALENDAR_COUNT_COLORS;
  try {
    const parsed = JSON.parse(value) as Partial<CalendarCountColors>;
    const validColor = (color: unknown): color is string => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);
    return {
      low: validColor(parsed.low) ? parsed.low : DEFAULT_CALENDAR_COUNT_COLORS.low,
      medium: validColor(parsed.medium) ? parsed.medium : DEFAULT_CALENDAR_COUNT_COLORS.medium,
      high: validColor(parsed.high) ? parsed.high : DEFAULT_CALENDAR_COUNT_COLORS.high,
    };
  } catch {
    return DEFAULT_CALENDAR_COUNT_COLORS;
  }
}

import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { EntityId, LocalDate } from '@/domain/shared/types';

export interface WeatherForecastQuery<TLocation = unknown> {
  householdId: EntityId;
  location: TLocation;
  from: LocalDate;
  through: LocalDate;
}

export interface WeatherForecastProvider<TLocation = unknown, TForecast = unknown> {
  fetchForecast(query: WeatherForecastQuery<TLocation>): Promise<TForecast>;
}

export interface WeatherScheduleAdjustment<TData = unknown> {
  scheduleEntryId: EntityId;
  data: TData;
}

export interface WeatherAdjustmentPolicy<TForecast = unknown, TData = unknown> {
  proposeAdjustments(input: {
    forecast: TForecast;
    schedule: readonly ChoreScheduleEntry[];
  }): readonly WeatherScheduleAdjustment<TData>[];
}

/** Weather retrieval and schedule changes stay disabled until the product rules are decided. */
export const WEATHER_ADJUSTMENTS_ENABLED = false;

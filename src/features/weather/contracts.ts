import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { EntityId, GeoCoordinates, LocalDate } from '@/domain/shared/types';

export interface DailyWeather {
  date: LocalDate;
  weatherCode: number | null;
  precipitationProbability: number | null;
  /** Open-Meteo daily precipitation_sum, in millimeters. */
  precipitationMm: number | null;
}

export interface WeatherForecastQuery<TLocation = GeoCoordinates> {
  householdId: EntityId;
  location: TLocation;
  from: LocalDate;
  through: LocalDate;
}

export interface WeatherForecastProvider<TLocation = GeoCoordinates, TForecast = readonly DailyWeather[]> {
  fetchForecast(query: WeatherForecastQuery<TLocation>): Promise<TForecast>;
}

export interface WeatherScheduleAdjustment<TData = unknown> {
  scheduleEntryId: EntityId;
  data: TData;
}

export interface WeatherAdjustmentPolicy<TForecast = readonly DailyWeather[], TData = unknown> {
  proposeAdjustments(input: {
    forecast: TForecast;
    schedule: readonly ChoreScheduleEntry[];
  }): readonly WeatherScheduleAdjustment<TData>[];
}

/** Weather changes are opt-in through the user's saved location in Settings. */
export const WEATHER_ADJUSTMENTS_ENABLED = true;

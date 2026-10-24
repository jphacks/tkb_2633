import { addDays, daysBetween, parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { WeatherLocation } from '@/domain/shared/types';
import type { DailyWeather, WeatherForecastProvider, WeatherForecastQuery } from './contracts';

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 15 * 60 * 1000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Parses only the daily fields the app needs; null values remain unknown. */
export function parseOpenMeteoDailyResponse(value: unknown): DailyWeather[] {
  if (!isRecord(value) || !isRecord(value.daily)) {
    throw new Error('Open-Meteo response is missing daily data');
  }

  const times = value.daily.time;
  const codes = value.daily.weather_code;
  const probabilities = value.daily.precipitation_probability_max;
  const amounts = value.daily.precipitation_sum;
  if (!Array.isArray(times) || !Array.isArray(codes) || !Array.isArray(probabilities) || !Array.isArray(amounts)) {
    throw new Error('Open-Meteo response is missing required daily arrays');
  }
  if (times.length !== codes.length || times.length !== probabilities.length || times.length !== amounts.length) {
    throw new Error('Open-Meteo daily arrays have different lengths');
  }

  return times.map((dateValue, index) => {
    if (typeof dateValue !== 'string') throw new Error(`Invalid Open-Meteo date at index ${index}`);
    const date = dateValue as DailyWeather['date'];
    try {
      parseLocalDate(date);
    } catch {
      throw new Error(`Invalid Open-Meteo date at index ${index}`);
    }

    return {
      date,
      weatherCode: nullableInteger(codes[index], 'weather_code', index),
      precipitationProbability: nullableNumber(probabilities[index], 'precipitation_probability_max', index, 0, 100),
      precipitationMm: nullableNumber(amounts[index], 'precipitation_sum', index, 0),
    };
  });
}

/** Open-Meteo forecast client with a short in-memory cache for repeated screen refreshes. */
export class OpenMeteoForecastProvider implements WeatherForecastProvider<WeatherLocation, readonly DailyWeather[]> {
  private readonly cache = new Map<string, { expiresAt: number; forecast: DailyWeather[] }>();
  private readonly pending = new Map<string, Promise<DailyWeather[]>>();
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(
    fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    now: () => number = Date.now,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    this.fetcher = fetcher;
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  async fetchForecast(query: WeatherForecastQuery<WeatherLocation>): Promise<readonly DailyWeather[]> {
    validateQuery(query);
    const cacheKey = [query.location.latitude.toFixed(3), query.location.longitude.toFixed(3), query.from, query.through].join(':');
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.forecast.map((day) => ({ ...day }));
    if (cached) this.cache.delete(cacheKey);

    let request = this.pending.get(cacheKey);
    if (!request) {
      request = this.fetchUncachedForecast(query, cacheKey);
      this.pending.set(cacheKey, request);
    }
    try {
      return (await request).map((day) => ({ ...day }));
    } finally {
      if (this.pending.get(cacheKey) === request) this.pending.delete(cacheKey);
    }
  }

  private async fetchUncachedForecast(query: WeatherForecastQuery<WeatherLocation>, cacheKey: string): Promise<DailyWeather[]> {
    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set('latitude', String(query.location.latitude));
    url.searchParams.set('longitude', String(query.location.longitude));
    url.searchParams.set('daily', 'weather_code,precipitation_probability_max,precipitation_sum');
    url.searchParams.set('precipitation_unit', 'mm');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('start_date', query.from);
    url.searchParams.set('end_date', query.through);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`Open-Meteo request failed with HTTP ${response.status}`);
      const forecast = parseOpenMeteoDailyResponse(await response.json());
      const requestedForecast = forecast.filter((day) => day.date >= query.from && day.date <= query.through);
      this.cache.set(cacheKey, { expiresAt: this.now() + CACHE_TTL_MS, forecast: requestedForecast });
      return requestedForecast;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateQuery(query: WeatherForecastQuery<WeatherLocation>): void {
  const { latitude, longitude } = query.location;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('Weather location coordinates are invalid');
  }
  const days = daysBetween(query.from, query.through);
  if (days < 0 || days > 6) throw new RangeError('Weather query must cover at most seven days');
  parseLocalDate(query.from);
  parseLocalDate(query.through);
  if (addDays(query.from, days) !== query.through) throw new RangeError('Weather query range is invalid');
}

function nullableInteger(value: unknown, field: string, index: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid Open-Meteo ${field} at index ${index}`);
  }
  return value;
}

function nullableNumber(value: unknown, field: string, index: number, minimum: number, maximum = Number.POSITIVE_INFINITY): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid Open-Meteo ${field} at index ${index}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

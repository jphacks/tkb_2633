import type { GeoCoordinates } from '@/domain/shared/types';

const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REQUEST_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WeatherRegionCandidate extends GeoCoordinates {
  id: number;
  label: string;
  countryCode?: string;
}

/** Parses the public Open-Meteo geocoding response into selectable region candidates. */
export function parseOpenMeteoGeocodingResponse(value: unknown): WeatherRegionCandidate[] {
  if (!isRecord(value)) throw new Error('地域検索の応答を読み取れませんでした');
  if (value.error === true) {
    throw new Error(typeof value.reason === 'string' ? value.reason : '地域検索に失敗しました');
  }
  if (value.results === undefined) return [];
  if (!Array.isArray(value.results)) throw new Error('地域検索の候補形式が正しくありません');

  return value.results.map((item, index) => {
    if (!isRecord(item)
      || typeof item.id !== 'number' || !Number.isInteger(item.id)
      || typeof item.name !== 'string' || item.name.trim().length === 0
      || typeof item.latitude !== 'number' || !Number.isFinite(item.latitude) || item.latitude < -90 || item.latitude > 90
      || typeof item.longitude !== 'number' || !Number.isFinite(item.longitude) || item.longitude < -180 || item.longitude > 180) {
      throw new Error(`地域検索の候補 ${index + 1} を読み取れませんでした`);
    }

    const labelParts = [item.name, item.admin2, item.admin1, item.country]
      .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
      .map((part) => part.trim())
      .filter((part, partIndex, parts) => parts.findIndex((candidate) => candidate.toLocaleLowerCase() === part.toLocaleLowerCase()) === partIndex);

    return {
      id: item.id,
      label: labelParts.join(', '),
      latitude: item.latitude,
      longitude: item.longitude,
      ...(typeof item.country_code === 'string' ? { countryCode: item.country_code } : {}),
    };
  });
}

/** Search endpoint for an explicitly entered region. It never reads device location. */
export class OpenMeteoGeocodingProvider {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetcher: FetchLike = globalThis.fetch.bind(globalThis), timeoutMs = REQUEST_TIMEOUT_MS) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async search(region: string): Promise<WeatherRegionCandidate[]> {
    const query = region.trim();
    if (query.length < 2 || query.length > 120) throw new RangeError('地域名は2〜120文字で入力してください');

    const url = new URL(OPEN_METEO_GEOCODING_URL);
    url.searchParams.set('name', query);
    url.searchParams.set('count', '10');
    url.searchParams.set('language', 'ja');
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`地域検索に失敗しました（HTTP ${response.status}）`);
      return parseOpenMeteoGeocodingResponse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

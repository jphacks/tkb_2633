import type { GeoCoordinates } from '@/domain/shared/types';

const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const REQUEST_TIMEOUT_MS = 10_000;
const MUNICIPAL_FEATURE_CODES = new Set(['PPLC', 'PPLA', 'PPLA2', 'PPLA3', 'PPLA4', 'PPLG', 'PPL']);

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WeatherRegionCandidate extends GeoCoordinates {
  id: number;
  label: string;
  name: string;
  countryCode?: string;
  featureCode?: string;
  population?: number;
}

/** Parses the public Open-Meteo geocoding response into Japanese municipality candidates. */
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

    const name = item.name.trim();
    const admin1 = typeof item.admin1 === 'string' ? item.admin1.trim() : '';
    const label = [name, admin1]
      .filter((part, partIndex, parts) => part.length > 0
        && parts.findIndex((candidate) => candidate.toLocaleLowerCase() === part.toLocaleLowerCase()) === partIndex)
      .join(', ');

    return {
      id: item.id,
      name,
      label,
      latitude: item.latitude,
      longitude: item.longitude,
      ...(typeof item.country_code === 'string' ? { countryCode: item.country_code } : {}),
      ...(typeof item.feature_code === 'string' ? { featureCode: item.feature_code } : {}),
      ...(typeof item.population === 'number' && Number.isFinite(item.population) ? { population: item.population } : {}),
    };
  });
}

/** Search is limited to Japanese cities, wards, towns and villages. Device location is never read. */
export class OpenMeteoGeocodingProvider {
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(fetcher: FetchLike = globalThis.fetch.bind(globalThis), timeoutMs = REQUEST_TIMEOUT_MS) {
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async search(region: string, signal?: AbortSignal): Promise<WeatherRegionCandidate[]> {
    const query = region.trim();
    if (query.length < 2 || query.length > 120) throw new RangeError('市区町村名は2〜120文字で入力してください');

    // Open-Meteo treats two-character searches as exact matches. Add the common
    // city suffix for shorthand input so "横浜" resolves to "横浜市".
    const searchName = /[市区町村]$/u.test(query) ? query : `${query}市`;
    return (await this.searchName(searchName, signal))
      .filter(isMunicipality)
      .sort((left, right) => (right.population ?? 0) - (left.population ?? 0)
        || left.label.localeCompare(right.label, 'ja'))
      .slice(0, 8);
  }

  private async searchName(name: string, signal?: AbortSignal): Promise<WeatherRegionCandidate[]> {
    const url = new URL(OPEN_METEO_GEOCODING_URL);
    url.searchParams.set('name', name);
    url.searchParams.set('count', '20');
    url.searchParams.set('language', 'ja');
    url.searchParams.set('countryCode', 'JP');
    url.searchParams.set('format', 'json');

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, this.timeoutMs);
    try {
      const response = await this.fetcher(url.toString(), { signal: controller.signal });
      if (!response.ok) throw new Error(`地域検索に失敗しました（HTTP ${response.status}）`);
      return parseOpenMeteoGeocodingResponse(await response.json());
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function isMunicipality(candidate: WeatherRegionCandidate): boolean {
  return /[市区町村]$/u.test(candidate.name)
    && MUNICIPAL_FEATURE_CODES.has(candidate.featureCode ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

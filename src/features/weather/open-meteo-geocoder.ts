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

    const kanaQuery = toKanaSearchQuery(query);
    if (kanaQuery !== null) {
      if (kanaQuery.length < 2) return [];
      return (await this.searchName(kanaQuery, signal))
        .filter(isMunicipality)
        .sort((left, right) => (right.population ?? 0) - (left.population ?? 0)
          || left.label.localeCompare(right.label, 'ja'))
        .slice(0, 8);
    }

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

const kanaToRomaji: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
};

const kanaDigraphToRomaji: Record<string, string> = {
  きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo',
  しゃ: 'sha', しゅ: 'shu', しょ: 'sho',
  ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho',
  にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
  ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo',
  みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
  りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo',
  ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
  じゃ: 'ja', じゅ: 'ju', じょ: 'jo',
  びゃ: 'bya', びゅ: 'byu', びょ: 'byo',
  ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
  てぃ: 'ti', でぃ: 'di', ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo',
};

/** Converts kana location queries to the romanized names indexed by Open-Meteo. */
function toKanaSearchQuery(value: string): string | null {
  const normalized = value.normalize('NFKC');
  if (!/^[\u3041-\u3096\u30A1-\u30FA\u30FC\s]+$/u.test(normalized)) return null;

  const hiragana = [...normalized].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x30a1 && codePoint <= 0x30f6
      ? String.fromCodePoint(codePoint - 0x60)
      : character;
  }).join('').replace(/\s/gu, '');
  const municipalitySuffixes = ['ちょう', 'まち', 'むら', 'そん', 'し', 'く'];
  const municipalitySuffix = municipalitySuffixes.find((suffix) => hiragana.endsWith(suffix));
  const name = municipalitySuffix ? hiragana.slice(0, -municipalitySuffix.length) : hiragana;
  let result = '';

  for (let index = 0; index < name.length; index += 1) {
    const character = name[index];
    if (character === 'っ') {
      const next = kanaDigraphToRomaji[name.slice(index + 1, index + 3)]
        ?? kanaToRomaji[name[index + 1]];
      if (next) result += next.startsWith('ch') ? 'c' : /^[bcdfghjklmnpqrstvwxyz]/u.exec(next)?.[0] ?? '';
      continue;
    }
    if (character === 'ー') continue;

    const digraph = kanaDigraphToRomaji[name.slice(index, index + 2)];
    if (digraph) {
      result += digraph;
      index += 1;
    } else {
      result += kanaToRomaji[character] ?? '';
    }
  }

  // Common Japanese place-name spellings omit long-vowel marks (Tokyo, Osaka, Kyoto).
  return result.replace(/ou/gu, 'o').replace(/([aeiou])\1+/gu, '$1');
}

function isMunicipality(candidate: WeatherRegionCandidate): boolean {
  return /[市区町村]$/u.test(candidate.name)
    && MUNICIPAL_FEATURE_CODES.has(candidate.featureCode ?? '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

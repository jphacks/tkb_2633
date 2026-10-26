import { useEffect, useState } from 'react';

import { OpenMeteoGeocodingProvider } from '@/features/weather/open-meteo-geocoder';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';

const geocoder = new OpenMeteoGeocodingProvider();
const SEARCH_DEBOUNCE_MS = 350;

export type MunicipalitySearchStatus = 'idle' | 'debouncing' | 'searching' | 'results' | 'empty' | 'error';

export interface MunicipalitySuggestions {
  query: string;
  candidates: WeatherRegionCandidate[];
  status: MunicipalitySearchStatus;
  error: string | null;
}

/** Shows Japanese municipality suggestions shortly after the user pauses typing. */
export function useMunicipalitySuggestions(query: string, enabled = true): MunicipalitySuggestions {
  const normalizedQuery = query.trim();
  const [suggestions, setSuggestions] = useState<MunicipalitySuggestions>({ query: '', candidates: [], status: 'idle', error: null });

  useEffect(() => {
    if (!enabled || normalizedQuery.length < 2) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      setSuggestions({ query: normalizedQuery, candidates: [], status: 'searching', error: null });
      void geocoder.search(normalizedQuery, controller.signal).then((candidates) => {
        if (controller.signal.aborted) return;
        setSuggestions({ query: normalizedQuery, candidates, status: candidates.length > 0 ? 'results' : 'empty', error: null });
      }).catch(() => {
        if (controller.signal.aborted) return;
        setSuggestions({
          query: normalizedQuery,
          candidates: [],
          status: 'error',
          error: '市区町村を検索できませんでした。入力内容と通信状態を確認して、もう一度入力してください。',
        });
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [enabled, normalizedQuery]);

  if (!enabled || normalizedQuery.length < 2) return { query: normalizedQuery, candidates: [], status: 'idle', error: null };
  if (suggestions.query !== normalizedQuery) return { query: normalizedQuery, candidates: [], status: 'debouncing', error: null };
  return suggestions;
}

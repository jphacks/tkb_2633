import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { OpenMeteoForecastProvider } = await import('../src/features/weather/open-meteo-provider.ts');
const { OpenMeteoGeocodingProvider } = await import('../src/features/weather/open-meteo-geocoder.ts');
const { WEATHER_FORECAST_CACHE_TTL_MS } = await import('../src/features/weather/contracts.ts');

const query = { householdId: 'synthetic-home', location: { latitude: 35.44, longitude: 139.64 }, from: '2026-10-26', through: '2026-10-26' };
const dailyResponse = (code = 0) => ({ daily: { time: [query.from], weather_code: [code], precipitation_probability_max: [0], precipitation_sum: [0] } });

test('forecast caching expires at the boundary and invalidates data from a clock rollback', async () => {
  let clock = 10_000; let calls = 0;
  const provider = new OpenMeteoForecastProvider(async () => ({ ok: true, json: async () => dailyResponse(++calls) }), () => clock);
  assert.equal((await provider.fetchForecast(query))[0].weatherCode, 1);
  clock += WEATHER_FORECAST_CACHE_TTL_MS - 1;
  assert.equal((await provider.fetchForecast(query))[0].weatherCode, 1);
  clock++;
  assert.equal((await provider.fetchForecast(query))[0].weatherCode, 2);
  clock -= 1_000;
  assert.equal((await provider.fetchForecast(query))[0].weatherCode, 3);
  assert.equal(calls, 3);
});

test('changing locations discards expired forecast keys instead of retaining every past search', async () => {
  let clock = 0; let calls = 0;
  const provider = new OpenMeteoForecastProvider(async () => ({ ok: true, json: async () => { calls++; return dailyResponse(); } }), () => clock);
  for (let index = 0; index < 80; index++) {
    clock += WEATHER_FORECAST_CACHE_TTL_MS;
    await provider.fetchForecast({ ...query, location: { ...query.location, latitude: index / 10 } });
  }
  assert.equal(calls, 80);
  assert.equal(provider.cache.size, 1, 'only the current, unexpired location should remain in memory');
});

for (const count of [1, 100, 500]) {
  test(`${count} simultaneous forecast requests share failure and retry without sharing mutable results`, async () => {
    let calls = 0; let fail = true;
    const provider = new OpenMeteoForecastProvider(async () => {
      calls++;
      if (fail) throw new Error('synthetic network failure');
      return { ok: true, json: async () => dailyResponse() };
    });
    const failed = await Promise.allSettled(Array.from({ length: count }, () => provider.fetchForecast(query)));
    assert.ok(failed.every((result) => result.status === 'rejected'));
    assert.equal(calls, 1);
    fail = false;
    const results = await Promise.all(Array.from({ length: count }, () => provider.fetchForecast(query)));
    assert.equal(calls, 2);
    results[0][0].weatherCode = 99;
    assert.equal((await provider.fetchForecast(query))[0].weatherCode, 0);
    if (count > 1) assert.equal(results[1][0].weatherCode, 0);
    assert.equal(provider.pending.size, 0);
  });
}

const names = [
  ['とうきょう', 'tokyo'], ['トウキョウシ', 'tokyo'], ['おおさかし', 'osaka'], ['ｵｵｻｶｼ', 'osaka'],
  ['さっぽろし', 'sapporo'], ['キョウトシ', 'kyoto'], ['よこはまし', 'yokohama'], ['ハママツシ', 'hamamatsu'],
  ['ちゃたんちょう', 'chatan'], ['しんじゅくく', 'shinjuku'], ['にっこうし', 'nikko'], ['オーサカシ', 'osaka'],
];
for (const [input, expected] of names) {
  test(`municipality kana conversion retains ${input} as ${expected} and filters non-municipal results`, async () => {
    let requested;
    const provider = new OpenMeteoGeocodingProvider(async (url) => {
      requested = new URL(url);
      return { ok: true, json: async () => ({ results: [
        { id: 1, name: '横浜市', latitude: 35.4, longitude: 139.6, feature_code: 'PPLA', population: 3_000_000 },
        { id: 2, name: '横浜駅', latitude: 35.4, longitude: 139.6, feature_code: 'RSTN' },
        { id: 3, name: '横浜村', latitude: 35.4, longitude: 139.6, feature_code: 'PPL', population: 100 },
      ] }) };
    });
    assert.deepEqual((await provider.search(input)).map((candidate) => candidate.id), [1, 3]);
    assert.equal(requested.searchParams.get('name'), expected);
    assert.equal(requested.searchParams.get('countryCode'), 'JP');
  });
}

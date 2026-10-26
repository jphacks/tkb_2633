import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

function searchHook(search) {
  let state;
  let dependencies;
  let cleanup;
  const { useMunicipalitySuggestions } = loadNativeModule('src/features/weather/use-municipality-suggestions.ts', {
    react: {
      useState(initial) {
        state ??= initial;
        return [state, (next) => { state = next; }];
      },
      useEffect(effect, nextDependencies) {
        if (JSON.stringify(dependencies) === JSON.stringify(nextDependencies)) return;
        cleanup?.();
        dependencies = nextDependencies;
        cleanup = effect();
      },
    },
    '@/features/weather/open-meteo-geocoder': { OpenMeteoGeocodingProvider: class { search = search; } },
  });
  return { render: useMunicipalitySuggestions, dispose: () => cleanup?.() };
}

for (const [platform, message] of [
  ['Android DNS', 'fetch failed: java.net.UnknownHostException: Unable to resolve host "geocoding-api.open-meteo.com"'],
  ['iOS offline', 'Network request failed'],
  ['upstream response', 'Invalid input or third-party diagnostic detail'],
]) {
  test(`municipality search presents a Japanese recovery message after ${platform} failure`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const hook = searchHook(async () => { throw new Error(message); });
    t.after(hook.dispose);
    assert.equal(hook.render('Yokohama').status, 'debouncing');
    t.mock.timers.tick(350);
    await new Promise(setImmediate);
    const result = hook.render('Yokohama');
    assert.equal(result.status, 'error');
    assert.deepEqual(result.candidates, []);
    assert.match(result.error, /市区町村を検索できませんでした/);
    assert.match(result.error, /もう一度入力/);
    assert.ok(!result.error.includes(message), 'native and upstream diagnostics must not become product copy');
  });
}

test('municipality search recovers after editing an offline query and ignores an obsolete in-flight result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = [];
  const hook = searchHook((query, signal) => new Promise((resolve, reject) => { pending.push({ query, signal, resolve, reject }); }));
  t.after(hook.dispose);
  hook.render('Yokohama');
  t.mock.timers.tick(350);
  pending[0].reject(new Error('offline'));
  await new Promise(setImmediate);
  assert.equal(hook.render('Yokohama').status, 'error');

  assert.equal(hook.render('Sapporo').status, 'debouncing');
  t.mock.timers.tick(350);
  assert.equal(hook.render('Sapporo').status, 'searching');
  hook.render('Tokyo');
  assert.equal(pending[1].signal.aborted, true);
  t.mock.timers.tick(350);
  pending[1].resolve([{ id: 1, label: '札幌市, 北海道' }]);
  await new Promise(setImmediate);
  assert.equal(hook.render('Tokyo').status, 'searching');
  const candidates = [{ id: 2, label: '新宿区, 東京都' }];
  pending[2].resolve(candidates);
  await new Promise(setImmediate);
  assert.deepEqual(hook.render('Tokyo'), { query: 'Tokyo', candidates, status: 'results', error: null });
  assert.equal(hook.render('Tokyo', false).status, 'idle');
  assert.equal(pending[2].signal.aborted, true);
});

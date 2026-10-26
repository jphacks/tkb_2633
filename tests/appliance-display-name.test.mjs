import assert from 'node:assert/strict';
import test from 'node:test';
import { applianceDisplayName } from '../src/features/appliance-care/display-name.ts';

const cases = [
  ['unprefixed product', 'Dyson', 'V12 Detect Slim', 'SV20', 'Dyson V12 Detect Slim（SV20）'],
  ['official brand prefix', 'Dyson', 'Dyson V12 Detect Slim', 'SV20', 'Dyson V12 Detect Slim（SV20）'],
  ['case variation', 'Dyson', 'DYSON V12', 'SV20', 'DYSON V12（SV20）'],
  ['full width prefix', 'Dyson', 'Ｄｙｓｏｎ　V12', 'SV20', 'Ｄｙｓｏｎ　V12（SV20）'],
  ['Japanese brand', 'パナソニック', 'パナソニック ナノケア', 'EH-NA0J', 'パナソニック ナノケア（EH-NA0J）'],
  ['partial prefix stays distinct', 'Dyson', 'Dysonic Cleaner', 'A1', 'Dyson Dysonic Cleaner（A1）'],
  ['brand inside product is retained', 'Dyson', 'Cleaner for Dyson', 'A1', 'Dyson Cleaner for Dyson（A1）'],
  ['candidate without model', 'Dyson', 'Dyson V12', undefined, 'Dyson V12'],
  ['whitespace is trimmed at edges', ' Dyson ', ' V12 ', 'SV20', 'Dyson V12（SV20）'],
  ['empty manufacturer adds no space', '', 'V12', 'SV20', 'V12（SV20）'],
];
for (const [name, manufacturer, productName, modelNumber, expected] of cases) {
  test(`appliance label: ${name}`, () => {
    const product = Object.freeze({ manufacturer, productName, modelNumber });
    assert.equal(applianceDisplayName(product), expected);
  });
}

test('only automatically generated saved names are reformatted', () => {
  const product = { manufacturer: 'Dyson', productName: 'Dyson V12', modelNumber: 'SV20' };
  assert.equal(applianceDisplayName(product, 'Dyson Dyson V12（SV20）'), 'Dyson V12（SV20）');
  assert.equal(applianceDisplayName(product, 'リビングの掃除機'), 'リビングの掃除機');
  assert.equal(applianceDisplayName(product, ''), '');
});

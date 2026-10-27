import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { v2MemberLabels } from '../src/features/sharing/v2-ui/member-labels.ts';

test('v2 identical shared profile names remain distinguishable across source order without exposing account IDs', () => {
  const members = [{ userId: 'owner', displayName: 'メンバー' }, { userId: 'member', displayName: 'メンバー' }, { userId: 'other', displayName: '太郎' }];
  for (const input of [members, [...members].reverse()]) {
    const name = v2MemberLabels(input); assert.equal(name('owner'), 'メンバー（2）'); assert.equal(name('member'), 'メンバー（1）');
    assert.equal(name('other'), '太郎'); assert.equal(name('absent'), '以前のメンバー');
    assert.equal(name('owner').includes('owner'), false);
  }
});

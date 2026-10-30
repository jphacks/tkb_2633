import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';
import { createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { privateCalendarPairingReference } from '../src/features/sharing/private-calendar/pairing.ts';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';

const userId = 'device-screen-owner';
function settings(t, cloud) {
  const f = privateCalendarSetupFixture(t, { userId }); const session = createPrivateCalendarDeviceSession({ userId,
    assertOwner: () => assert.equal(f.state.currentUser, userId, 'owner changed'), secrets: f.secrets, roots: f.roots, intents: f.changes,
    candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud }); return { ...f, session };
}
async function open(session, platform) {
  let mount; const shared = []; let backs = 0;
  const screen = screenHarness('src/features/sharing/private-calendar/device-screen.tsx', { exportName: 'PrivateCalendarDeviceScreen', platform,
    effect: callback => { mount ??= callback; }, props: { loadSession: async () => session, onBack: () => { backs++; }, onShare: async value => { shared.push(structuredClone(value)); } } });
  const cleanup = mount();
  for (let n = 0; n < 30 && screen.button('端末内の設定を再読込').props.disabled; n++) await screen.flush();
  assert.equal(screen.button('端末内の設定を再読込').props.disabled, false);
  return { screen, shared, backs: () => backs, close: cleanup };
}

for (const platform of ['ios','android']) {
  test(`${platform} private device settings require explicit confirmation for first setup and keep pairing preview read only`, async t => {
    const h = privateCalendarMemoryCloud(); const f = settings(t, h.cloud); const ui = await open(f.session, platform); t.after(ui.close);
    assert.match(ui.screen.text(), /未設定/u); assert.equal(f.state.generations, 0); assert.equal(h.history.length, 0);
    await ui.screen.press('この端末が最初です'); assert.equal(f.state.generations, 0); assert.equal(h.history.length, 0);
    await ui.screen.press('操作を取りやめる'); assert.equal(f.values.size, 0);
    await ui.screen.press('この端末が最初です'); await ui.screen.press('確認して実行'); assert.equal(h.history.length, 1); assert.match(ui.screen.text(), /承認済み/u);
    await ui.screen.press('本人端末の確認情報を渡す'); assert.equal(ui.shared.length, 1); assert.equal(ui.shared[0].anchor.ownerUserId, userId);
    assert.equal(JSON.stringify(ui.shared).includes('SecretKey'), false);
  });

  test(`${platform} private device settings use the actual signed pairing handlers and show pending delivery without claiming it was sent`, async t => {
    const h = privateCalendarMemoryCloud(); const a = settings(t,h.cloud); const b = settings(t,h.cloud); const first = await a.session.initializeFirstDevice();
    const recipient = await open(b.session,platform); const owner = await open(a.session,platform); t.after(recipient.close); t.after(owner.close);
    await recipient.screen.change('本人端末の確認情報',JSON.stringify(first.reference)); await recipient.screen.press('確認情報を照合');
    assert.equal(b.state.generations,0); assert.match(recipient.screen.text(),new RegExp(first.reference.anchor.rootDigest));
    await recipient.screen.press('照合した情報で依頼を作成'); assert.match(recipient.screen.text(),/承認待ち/u);
    await recipient.screen.press('この端末の確認依頼を渡す'); const request=recipient.shared[0]; assert.ok(request.signature); assert.equal(h.history.length,1);
    await owner.screen.change('別端末の確認依頼',JSON.stringify(request)); await owner.screen.press('確認依頼を照合'); assert.equal(h.history.length,1);
    assert.match(owner.screen.text(),new RegExp(request.body.device.deviceId)); h.flags.keyReplyLost=true;
    await owner.screen.press('照合した端末を承認'); assert.match(owner.screen.text(),/配布 1件が送信待ち/u);
    await owner.screen.press('端末設定を同期'); assert.equal((await a.session.read()).pendingKeys,0);
    await recipient.screen.press('承認と鍵の受信を確認'); assert.match(recipient.screen.text(),/鍵はこの端末に保存済み/u); assert.equal(h.history.length,2);
    await owner.screen.press(`端末 ${request.body.device.deviceId.slice(7,15)}をメインにする`); assert.equal(h.history.length,2);
    await owner.screen.press('操作を取りやめる'); assert.equal(h.history.length,2);
  });

  test(`${platform} private device settings reject malformed foreign and oversized information without creating a device`, async t => {
    const h=privateCalendarMemoryCloud(); const f=settings(t,h.cloud); const ui=await open(f.session,platform); t.after(ui.close);
    const foreign=privateCalendarPairingReference(await createPrivateCalendarRoot(sharingTestCrypto,'foreign-owner',await createDeviceIdentity(sharingTestCrypto)));
    for (const value of ['{bad',JSON.stringify(foreign),'x'.repeat(8001)]) {
      await ui.screen.change('本人端末の確認情報',value); await ui.screen.press('確認情報を照合');
      assert.match(ui.screen.text(),/一致しません/u); assert.equal(f.state.generations,0); assert.equal(h.history.length,0);
      assert.ok(!ui.screen.nodes().some(node=>node.props.accessibilityRole==='button'&&node.children?.includes('照合した情報で依頼を作成')));
    }
  });

  test(`${platform} private device settings require another confirmation for revocation and retain the removed device records`, async t=>{
    const h=privateCalendarMemoryCloud(); const a=settings(t,h.cloud); const b=settings(t,h.cloud); const initial=await a.session.initializeFirstDevice();
    const prepared=await b.session.prepareConfirmedReference(initial.reference); await a.session.approveConfirmedRequest(prepared.request); await b.session.acceptApproval();
    const ui=await open(a.session,platform); t.after(ui.close); const label=`端末 ${prepared.deviceId.slice(7,15)}の承認を解除`;
    await ui.screen.press(label); assert.equal(h.history.length,2); assert.match(ui.screen.text(),/過去の端末保存データは削除しません/u);
    await ui.screen.press('確認して実行'); assert.equal(h.history.length,3); assert.equal((await a.session.read()).keyVersion,2);
    assert.equal((await b.session.synchronizeDevices()).phase,'revoked'); assert.equal((await b.readProtected()).hasStoredKeys,true);
  });

  test(`${platform} closing private device settings before session initialization prevents late protected reads and queued actions`, async()=>{
    let resolve; let mount; let reads=0;
    const waiting=new Promise(done=>{resolve=done;});
    const screen=screenHarness('src/features/sharing/private-calendar/device-screen.tsx',{exportName:'PrivateCalendarDeviceScreen',platform,
      effect:callback=>{mount??=callback;},props:{loadSession:()=>waiting,onBack(){},onShare:async()=>{}}});
    const cleanup=mount();const queued=screen.button('端末内の設定を再読込').props.onPress;cleanup();resolve({read:async()=>{reads++;throw new Error('must not read');}});
    await screen.flush();await queued();assert.equal(reads,0);assert.equal(screen.button('端末内の設定を再読込').props.disabled,true);
  });
}

test('private device route requires authenticated ownership before opening any Native service and links back to sharing login', async()=>{
  let opens=0; const moves=[]; const context={ready:true,userId:null}; const screen=screenHarness('src/app/sharing/private-calendar.tsx',{mocks:{
    '../../hooks/use-workspace':{useWorkspace:()=>context}, '../../platform/sharing/private-calendar-devices':{openPrivateCalendarDevices:()=>{opens++;throw new Error('must not open');}},
  },navigate:(...args)=>moves.push(args)});
  assert.equal(opens,0); await screen.press('共有用アカウントへ'); assert.deepEqual(moves.at(-1),['replace','/sharing']);
});

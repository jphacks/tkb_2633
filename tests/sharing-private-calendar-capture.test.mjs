import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarSourceStorage } from '../src/platform/storage/private-calendar-source.ts';
import { createPrivateCalendarSourceController, privateCalendarSourceBinding } from '../src/features/sharing/private-calendar/source-controller.ts';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
// Install the project's @/ resolver before loading the existing Calendar transport contracts.
const { createPrivateCalendarCapture } = await import('../src/features/sharing/private-calendar/calendar-capture.ts');
const { createCalendarQueryRange } = await import('../src/features/google-sync/calendar-availability.ts');

const userId = 'capture-firebase-owner'; const subject = 'explicit-different-google-subject'; const now = Date.parse('2026-10-28T00:00:00.000Z');
const range = createCalendarQueryRange('2026-10-28','2026-11-27','Asia/Tokyo');
async function fixture(t, configured = true) {
  const f = privateCalendarSetupFixture(t,{userId}); const h = privateCalendarMemoryCloud(); const state = { now, calls: 0, uploads: [], busy: [{start:'2026-10-28T00:00:00.000Z',end:'2026-10-28T01:00:00.000Z'}] };
  const source = createPrivateCalendarSourceStorage({ownerUserId:userId,readProtected:f.readProtected,exclusive:f.exclusive,vault:f.vault,assertOwner:uid=>assert.equal(f.state.currentUser,uid,'owner changed')});
  const authoritySync = createPrivateCalendarAuthoritySync({userId,secrets:f.secrets,intents:f.changes,cloud:h.cloud});
  const controller = createPrivateCalendarSourceController({userId,secrets:f.secrets,intents:f.changes,source,authoritySync});
  if(configured){await f.controller(h.cloud).prepareAndResume();await controller.change({googleSubject:subject},(await f.secrets.authority(userId)).digest);}
  const port={userId,secrets:f.secrets,source,cache:f.cache,crypto:f.gateway,assertOwner:()=>assert.equal(f.state.currentUser,userId,'owner changed'),now:()=>state.now,randomFraction:()=>0.5,
    cloud:{...h.cloud,async uploadCache(authority,encrypted){state.uploads.push(JSON.stringify(encrypted));return h.cloud.uploadCache(authority,encrypted);}},
    async queryGoogle(expected,query){assert.equal(expected,subject);assert.deepEqual(query,range);state.calls++;return state.busy;}};
  const open=()=>createPrivateCalendarCapture(port);return{f,h,source,controller,state,port,open,capture:open()};
}
async function read(f) {const authority=await f.f.secrets.authority(userId);const key=await f.f.secrets.currentKey(userId,authority);try{return await f.f.cache.read({authority,accountKey:key,calendarBinding:privateCalendarSourceBinding(authority)});}finally{key.fill(0);}}

test('private Calendar capture starts no login identity key query or publication when the explicit source is unconfigured or disabled',async t=>{
  const f=await fixture(t,false);assert.deepEqual(await f.capture.capture({range}),{kind:'unconfigured'});assert.equal(f.f.state.generations,0);assert.equal(f.state.calls,0);
  await f.f.controller(f.h.cloud).prepareAndResume();assert.deepEqual(await f.capture.capture({range}),{kind:'disabled'});assert.equal(f.state.calls,0);assert.equal(f.state.uploads.length,0);
});

test('private Calendar capture binds the selected subject clips and merges intervals and stores only an acknowledged encrypted snapshot',async t=>{
  const f=await fixture(t);f.state.busy=[...f.state.busy,{start:'2026-10-28T00:30:00.000Z',end:'2026-10-28T02:00:00.000Z'},
    {start:'2026-10-26T00:00:00.000Z',end:'2026-10-27T16:00:00.000Z'},{start:'2026-12-01T00:00:00.000Z',end:'2026-12-02T00:00:00.000Z'}];
  assert.deepEqual(await f.capture.capture({range}),{kind:'published',sequence:1});assert.equal(f.state.calls,1);assert.equal(f.state.uploads.length,1);
  const body=await read(f);assert.equal(body.ownerUserId,userId);assert.equal(body.mainRevision,2);assert.equal(body.fetchedAt,new Date(now).toISOString());
  assert.deepEqual(body.intervals,[{start:range.timeMin,end:'2026-10-27T16:00:00.000Z'},{start:'2026-10-28T00:00:00.000Z',end:'2026-10-28T02:00:00.000Z'}]);
  const json=JSON.stringify(f.f.connection.prepare('SELECT * FROM private_calendar_cache').all());assert.equal(json.includes(subject),false);assert.equal(json.includes('Asia/Tokyo'),false);assert.equal(json.includes(body.intervals[0].end),false);
  assert.equal((await f.f.cache.status(await f.f.secrets.authority(userId))).pending,false);
});

test('private Calendar capture coalesces one hundred matching operations and refuses a different range during acquisition',{timeout:30000},async t=>{
  const f=await fixture(t);let release;let enter;const gate=new Promise(done=>{release=done;});const entered=new Promise(done=>{enter=done;});const original=f.port.queryGoogle;
  f.port.queryGoogle=async(...args)=>{enter();await gate;return original(...args);};const client=f.open();const calls=Array.from({length:100},()=>client.capture({range}));await entered;assert.equal(new Set(calls).size,1);
  const other=createCalendarQueryRange('2026-10-28','2026-12-01','Asia/Tokyo');await assert.rejects(()=>client.capture({range:other}),/別の範囲/u);release();
  assert.ok((await Promise.all(calls)).every(value=>value.sequence===1));assert.equal(f.state.calls,1);assert.equal(f.state.uploads.length,1);
});

test('private Calendar capture retries the same encrypted envelope after reply loss without querying Google or allocating a new nonce',async t=>{
  const f=await fixture(t);let fail=true;const upload=f.port.cloud.uploadCache;f.port.cloud={...f.port.cloud,async uploadCache(...args){const result=await upload(...args);if(fail){fail=false;throw Object.assign(new Error('reply lost'),{code:'unavailable'});}return result;}};
  const client=f.open();await assert.rejects(()=>client.capture({range}),/reply lost/u);const authority=await f.f.secrets.authority(userId);assert.equal((await f.f.cache.status(authority)).pending,true);const allocations=f.f.state.generations;
  assert.equal((await f.open().capture({range})).kind,'waiting');assert.equal(f.state.calls,1);
  assert.deepEqual(await f.open().capture({range,force:true}),{kind:'published',sequence:1});assert.equal(f.state.calls,1);assert.equal(f.f.state.generations,allocations);assert.equal(f.state.uploads[0],f.state.uploads[1]);
});

test('private Calendar capture rejects malformed excessive and out-of-policy data without replacing the previous complete cache',async t=>{
  const f=await fixture(t);await f.capture.capture({range});const authority=await f.f.secrets.authority(userId);const original=(await f.f.cache.status(authority)).cursor.manifestDigest;
  const long=createCalendarQueryRange('2026-10-28','2027-12-31','Asia/Tokyo');assert.throws(()=>f.capture.capture({range:long}),/取得範囲/u);assert.equal(f.state.calls,1);
  const start=Date.parse(range.timeMin);const tooMany=Array.from({length:20001},(_,i)=>({start:new Date(start+i*120000).toISOString(),end:new Date(start+i*120000+60000).toISOString()}));
  for(const busy of [[{start:'2026-10-28',end:'2026-10-29'}],[{...f.state.busy[0],summary:'never-upload'}],Array(100001).fill(f.state.busy[0]),tooMany]){
    f.state.busy=busy;await assert.rejects(()=>f.capture.capture({range,force:true}));assert.equal((await f.f.cache.status(authority)).cursor.manifestDigest,original);assert.equal(f.state.uploads.length,1);
  }
});

test('private Calendar source changes during the Native encryption await cannot save or publish a stale acquisition and the temporary key is cleared',{timeout:30000},async t=>{
  const f=await fixture(t);let release;let enter;let held=false;const gate=new Promise(done=>{release=done;});const entered=new Promise(done=>{enter=done;});const keys=[];
  const secrets={...f.f.secrets,async currentKey(...args){const key=await f.f.secrets.currentKey(...args);if(key)keys.push(key);return key;}};
  const crypto={...f.port.crypto,async encrypt(...args){if(!held){held=true;enter();await gate;}return f.port.crypto.encrypt(...args);}};
  const client=createPrivateCalendarCapture({...f.port,secrets,crypto});const call=client.capture({range});await entered;
  await f.controller.change({googleSubject:'new-confirmed-google-subject'},(await f.f.secrets.authority(userId)).digest);release();await assert.rejects(()=>call,/変わりました/u);
  assert.equal(f.state.uploads.length,0);assert.equal(await f.f.cache.status(await f.f.secrets.authority(userId)),null);assert.ok(keys.length>0&&keys.every(key=>key.every(byte=>byte===0)));
});

test('private Calendar capture owner changes and account-binding errors cannot save data or silently choose another Google account',async t=>{
  const f=await fixture(t);f.port.queryGoogle=async expected=>{assert.equal(expected,subject);f.f.state.currentUser='foreign-owner';return f.state.busy;};
  await assert.rejects(()=>f.open().capture({range}),/owner changed/u);assert.equal(f.state.uploads.length,0);f.f.state.currentUser=userId;
  f.port.queryGoogle=async expected=>{assert.equal(expected,subject);throw Object.assign(new Error('different Google session'),{code:'google_account_mismatch'});};
  assert.equal((await f.open().capture({range})).kind,'inProgress');f.state.now+=120000;
  await assert.rejects(()=>f.open().capture({range}),/different Google session/u);assert.equal(f.state.uploads.length,0);assert.equal(await f.f.cache.status(await f.f.secrets.authority(userId)),null);
});

test('private Calendar pending retry validates its expected binding before publication and retains a mismatched candidate for review',async t=>{
  const f=await fixture(t);const authority=await f.f.secrets.authority(userId);const identity=await f.f.secrets.identity(userId);const key=await f.f.secrets.currentKey(userId,authority);const binding='unexpected-source-binding';
  try{const cache={ownerUserId:userId,accountGeneration:authority.anchor.accountGeneration,mainDeviceId:identity.deviceId,mainRevision:authority.signed.body.revision,calendarBinding:binding,timeZone:range.timeZone,fetchedAt:new Date(now).toISOString(),coverage:{start:range.timeMin,end:range.timeMax},intervals:[]};
    const encrypted=await sealPrivateCalendarCache(f.port.crypto,{cache,authority,accountKey:key,calendarBinding:binding,mainDevice:identity,sequence:1});await f.f.cache.save(encrypted,{authority,accountKey:key,calendarBinding:binding,origin:'local'});
    await assert.rejects(()=>f.capture.capture({range}));assert.equal(f.state.calls,0);assert.equal(f.state.uploads.length,0);assert.equal((await f.f.cache.status(authority)).pending,true);
  }finally{key.fill(0);}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';
const { createCalendarFreeBusyClient, CalendarFreeBusyError }=await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { createCalendarQueryRange, GOOGLE_CALENDAR_FREEBUSY_SCOPE, CalendarPermissionRequiredError }=await import('../src/features/google-sync/calendar-availability.ts');
const { authorizeCalendarAvailability }=await import('../src/features/google-sync/calendar-authorization.ts');
const range=createCalendarQueryRange('2026-10-25','2026-10-31','Asia/Tokyo');
test('181-day FreeBusy coverage is split into bounded contiguous POSTs and committed only after all succeed',async()=>{
  const full=createCalendarQueryRange('2026-10-25','2027-04-23','America/New_York');
  const chunks=[];let observed=0;
  const client=createCalendarFreeBusyClient(async(url,init)=>{
    const body=JSON.parse(init.body);chunks.push(body);
    assert.deepEqual(body.items,[{id:'primary'}]);assert.equal(body.timeZone,'America/New_York');
    assert.ok(Date.parse(body.timeMax)-Date.parse(body.timeMin)<=90*24*3600000);
    return Response.json({calendars:{primary:{busy:[]}}});
  },()=>observed++);
  assert.deepEqual(await client.query('fixture-token',full),[]);
  assert.equal(chunks.length,3);assert.equal(observed,3);
  assert.equal(chunks[0].timeMin,full.timeMin);assert.equal(chunks.at(-1).timeMax,full.timeMax);
  assert.equal(chunks[0].timeMax,chunks[1].timeMin);assert.equal(chunks[1].timeMax,chunks[2].timeMin);
  let count=0;
  const failure=createCalendarFreeBusyClient(async()=>{
    if(++count===2)return new Response('{}',{status:503});
    return Response.json({calendars:{primary:{busy:[{start:full.timeMin,end:chunks[0].timeMax}]}}});
  });
  await assert.rejects(failure.query('fixture-token',full));assert.equal(count,2);
});
test('FreeBusy classifies range errors without retaining the original service response',async()=>{
  const client=createCalendarFreeBusyClient(async()=>Response.json({error:{message:'The requested time range is too long.'}},{status:400}));
  await assert.rejects(client.query('fixture-token',range),(error)=>error.code==='calendar_time_range_too_long');
});
test('FreeBusy posts only primary coverage and returns only busy start/end',async()=>{
  const client=createCalendarFreeBusyClient(async(url,init)=>{
    assert.equal(url,'https://www.googleapis.com/calendar/v3/freeBusy');assert.equal(init.method,'POST');
    assert.ok(init.headers.Authorization.startsWith('Bearer '));assert.ok(init.signal);
    assert.deepEqual(JSON.parse(init.body),{timeMin:range.timeMin,timeMax:range.timeMax,timeZone:'Asia/Tokyo',items:[{id:'primary'}]});
    return Response.json({calendars:{primary:{busy:[{start:'2026-10-25T10:00:00Z',end:'2026-10-25T11:00:00Z',ignored:'discard'}]}}});
  });
  assert.deepEqual(await client.query('fixture-token',range),[{start:'2026-10-25T10:00:00Z',end:'2026-10-25T11:00:00Z'}]);
});
for(const [reason,status]of[['internalError',503],['forbidden',403],['newUnknownReason',400],['notFound',400]]){
  test('FreeBusy calendar-level '+reason+' is handled without a busy array',async()=>{
    const client=createCalendarFreeBusyClient(async()=>Response.json({calendars:{primary:{errors:[{reason}]}}}));
    await assert.rejects(client.query('fixture-token',range),(e)=>e instanceof CalendarFreeBusyError&&e.status===status);
  });
}
test('FreeBusy HTTP errors retain retry timing but never response messages',async()=>{
  const client=createCalendarFreeBusyClient(async()=>Response.json({error:{message:'not retained'}},{status:429,headers:{'Retry-After':'7200'}}));
  await assert.rejects(client.query('fixture-token',range),(e)=>e.status===429&&e.retryAfter==='7200'&&!e.message.includes('not retained'));
  const disabled=createCalendarFreeBusyClient(async()=>Response.json({error:{errors:[{reason:'accessNotConfigured'}]}},{status:403}));
  await assert.rejects(disabled.query('fixture-token',range),(e)=>e.code==='calendar_api_not_enabled');
});
for(const [reason,code]of[
  ['userRateLimitExceeded','calendar_rate_limited'],
  ['rateLimitExceeded','calendar_rate_limited'],
  ['insufficientPermissions','calendar_permission_required'],
  ['forbidden','calendar_permission_required'],
  ['quotaExceeded','calendar_http_403'],
]){
  test('FreeBusy HTTP 403 '+reason+' is distinguished from missing permission',async()=>{
    const client=createCalendarFreeBusyClient(async()=>Response.json({error:{errors:[{reason}]}},{status:403,headers:{'Retry-After':'7200'}}));
    await assert.rejects(client.query('fixture-token',range),(error)=>error.status===403&&error.code===code&&error.retryAfter==='7200');
  });
}
test('FreeBusy scope error without a reason maps to permissionRequired without retaining its message',async()=>{
  const client=createCalendarFreeBusyClient(async()=>Response.json({error:{message:'Request had insufficient authentication scopes.'}},{status:403}));
  await assert.rejects(client.query('fixture-token',range),(error)=>error.code==='calendar_permission_required'&&!error.message.includes('scopes'));
});
test('incremental consent requests only freebusy and denial leaves Tasks permission intact',async()=>{
  let scopes=['https://www.googleapis.com/auth/tasks'];let requests=0;
  const port={grantedScopes:async()=>scopes,requestScopes:async(requested)=>{requests++;assert.deepEqual(requested,[GOOGLE_CALENDAR_FREEBUSY_SCOPE]);return{};}};
  await assert.rejects(authorizeCalendarAvailability(port),CalendarPermissionRequiredError);
  assert.deepEqual(scopes,['https://www.googleapis.com/auth/tasks']);
  port.requestScopes=async(requested)=>{requests++;scopes=[...scopes,...requested];return{accessToken:'fixture-token'};};
  await authorizeCalendarAvailability(port);assert.equal(requests,2);
  await authorizeCalendarAvailability(port);assert.equal(requests,2);
});

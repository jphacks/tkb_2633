import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';
const { generateHouseworkSchedule }=await import('../src/domain/scheduling/engine.ts');
const { daysBetween }=await import('../src/domain/scheduling/local-date.ts');
function fixture(load='heavy',overrides={}){
 const chore={id:'test',householdId:'home',name:'test',category:'掃除',enabled:true,load,holidayPriority:false,
  frequencyDaysByMode:{frequent:7,balanced:7,relaxed:7},windowRadiusDays:0,maxShiftDays:4,instructions:[],tools:[],cautions:[],...overrides};
 return {householdId:'home',from:'2026-10-24',through:'2026-11-30',today:'2026-10-24',
  chores:[chore],states:[{choreId:'test',lastCompletedDate:'2026-10-20',initialPending:false}],
  assignments:[],dependencies:[],completions:[],
  settings:{frequencyMode:'balanced',restDays:[],loadLimits:{heavyDailyLimit:1,normalDailyLimit:2}}};
}
const busy={'2026-10-27':{busyMinutes:200}};
test('no Calendar, empty Calendar and all-zero availability produce identical full schedules',()=>{
 const input=fixture();const baseline=generateHouseworkSchedule(input);
 assert.deepEqual(generateHouseworkSchedule({...input,externalAvailabilityByDate:{}}),baseline);
 assert.deepEqual(generateHouseworkSchedule({...input,externalAvailabilityByDate:{'2026-10-27':{busyMinutes:0}}}),baseline);
 assert.equal(baseline[0].suggestedDate,'2026-10-27');
});
test('busy equivalent makes heavy move more readily while light stays near its base',()=>{
 const heavy=generateHouseworkSchedule({...fixture('heavy'),externalAvailabilityByDate:busy})[0];
 const normal=generateHouseworkSchedule({...fixture('normal'),externalAvailabilityByDate:busy})[0];
 const light=generateHouseworkSchedule({...fixture('light'),externalAvailabilityByDate:busy})[0];
 assert.equal(heavy.suggestedDate,'2026-10-26');assert.equal(normal.suggestedDate,'2026-10-26');
 assert.equal(light.suggestedDate,'2026-10-27');
 assert.equal(heavy.id,generateHouseworkSchedule(fixture())[0].id);
});
test('equal candidate distances prefer the less busy day',()=>{
 const entries=generateHouseworkSchedule({...fixture(),externalAvailabilityByDate:{
  '2026-10-27':{busyMinutes:1440},'2026-10-26':{busyMinutes:200}}});
 assert.equal(entries[0].suggestedDate,'2026-10-28');
});
test('Calendar respects maxShift and fixed occurrences and never removes all-busy chores',()=>{
 const input=fixture('heavy',{maxShiftDays:1});
 const days=Object.fromEntries(Array.from({length:7},(_,i)=>[`2026-10-${24+i}`,{busyMinutes:1440}]));
 const result=generateHouseworkSchedule({...input,externalAvailabilityByDate:days});
 assert.ok(Math.abs(daysBetween(result[0].cycleBaseDate,result[0].suggestedDate))<=1);
 const fixed=fixture('heavy',{maxShiftDays:0,windowRadiusDays:0});
 assert.deepEqual(generateHouseworkSchedule({...fixed,externalAvailabilityByDate:days}),generateHouseworkSchedule(fixed));
 assert.equal(result.length,generateHouseworkSchedule(input).length);
});
test('rest preference remains above Calendar soft cost',()=>{
 const input=fixture('heavy',{holidayPriority:true});
 input.settings.restDays=[7];
 const baseline=generateHouseworkSchedule(input);
 const result=generateHouseworkSchedule({...input,externalAvailabilityByDate:{'2026-10-25':{busyMinutes:1440}}});
 assert.equal(baseline[0].suggestedDate,'2026-10-25');assert.equal(result[0].suggestedDate,'2026-10-25');
});
test('Calendar keeps dependency ordering and overdue records unchanged',()=>{
 const input=fixture('heavy',{maxShiftDays:2});
 const first={...input.chores[0],id:'before'};
 input.chores.unshift(first);input.states.unshift({choreId:'before',initialPending:true,initialScheduledDate:'2026-10-28'});
 input.dependencies=[{id:'dependency',predecessorChoreId:'before',successorChoreId:'test'}];
 const result=generateHouseworkSchedule({...input,externalAvailabilityByDate:busy});
 assert.ok(result.find((entry)=>entry.choreId==='test').suggestedDate>='2026-10-28');
 const overdue=fixture('heavy',{maxShiftDays:0,windowRadiusDays:1});overdue.states[0].lastCompletedDate='2026-10-13';
 const before=generateHouseworkSchedule(overdue).filter((e)=>e.status==='overdue');
 assert.ok(before.length);
 assert.deepEqual(generateHouseworkSchedule({...overdue,externalAvailabilityByDate:busy}).filter((e)=>e.status==='overdue'),before);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import './helpers/typescript-loader.mjs';
const require=createRequire(import.meta.url);
const {patchSilentTokens}=require('../scripts/patch-google-signin-silent-tokens.cjs');
test('native Android token refresh cannot resolve authorization UI; incremental consent still can',()=>{
 const controller=`  suspend fun requestScopes(scopes: Array<String>) { authorize(offlineAccess = false) }
  suspend fun getTokens(): GetTokensResponse {
    val authResult =
      GoogleSignInAuthorizationHelper.authorize(
        scopes = scopes,
        offlineAccess = false,
      )

    val accessToken = authResult.accessToken
  }
  suspend fun clearCachedAccessToken(accessTokenString: String) {}`;
 const helper=`  suspend fun authorize(
    activity: Activity,
    context: ReactApplicationContext,
    accountEmail: String? = null,
  ) {
        val authClient = Identity.getAuthorizationClient(activity)
        if (initial.hasResolution()) {
          awaitAuthorizationResolution(activity, pendingIntent.intentSender)
        }
  }`;
 const patched=patchSilentTokens(controller,helper);
 assert.match(patched.controller,/getTokens\(\)[\s\S]*allowResolution = false/);
 assert.match(patched.helper,/if \(!allowResolution\)[\s\S]*SIGN_IN_REQUIRED[\s\S]*awaitAuthorizationResolution/);
 assert.match(patched.helper,/allowResolution: Boolean = true/);
 assert.match(patched.helper,/activity: Activity\?/);
 assert.match(patched.helper,/else Identity.getAuthorizationClient\(context\)/);
 assert.match(patched.helper,/foregroundActivity = activity \?: throw GoogleSignInException/);
 assert.doesNotMatch(patched.controller,/requireActivity\(\)/);
 assert.match(patched.controller,/catch \(error: GoogleSignInException\)[\s\S]*error.code != "SIGN_IN_REQUIRED"/);
 assert.match(patched.controller,/scopes = requestedScopes,[\s\S]*allowResolution = false/);
 assert.match(patched.controller,/authorizeSilently\(fallbackScopes\)/);
 assert.match(patched.controller,/preservedTaskScopes = scopes.filter \{ it == "https:\/\/www.googleapis.com\/auth\/tasks" \}/);
 assert.match(patched.controller,/saveScopesToStorage\(context, lastUserId, baseScopes.toSet\(\)\)/);
 assert.deepEqual(patchSilentTokens(patched.controller,patched.helper),patched);
 assert.throws(()=>patchSilentTokens('unsupported','unsupported'));
 const root=new URL('../node_modules/react-native-nitro-google-signin/android/src/main/java/com/nitrogooglesignin/',import.meta.url);
 const installedController=readFileSync(new URL('GoogleSignInController.kt',root),'utf8');
 const installedHelper=readFileSync(new URL('GoogleSignInAuthorizationHelper.kt',root),'utf8');
 assert.deepEqual(patchSilentTokens(installedController,installedHelper),{controller:installedController,helper:installedHelper});
 assert.match(installedController,/val initialScopes = \(getScopesFromStorage\(requireContext\(\), userId\) \+ configuredScopes/);
});
test('base native configuration requests identity only; Tasks and Calendar consent remain explicit',()=>{
 const source=readFileSync(new URL('../src/platform/google-tasks/google-sign-in-gateway.ts',import.meta.url),'utf8');
 assert.match(source,/scopes: \[\]/);
 const tasksAuth=source.slice(source.indexOf('export async function authorizeGoogleTasks'),source.indexOf('export async function getGoogleTasksAccessToken'));
 assert.match(tasksAuth,/requestScopes\(\[GOOGLE_TASKS_SCOPE\]\)/);
 const calendarAuth=source.slice(source.indexOf('export async function authorizeGoogleCalendarAvailability'),source.indexOf('export async function getGoogleCalendarAccessToken'));
 assert.match(calendarAuth,/AppState.currentState !== 'active'/);
 const getter=source.slice(source.indexOf('export async function getGoogleCalendarAccessToken'),source.indexOf('export async function disconnectGoogleTasksSession'));
 assert.doesNotMatch(getter,/requestScopes\(|presentExplicitSignIn\(|createAccount\(/);
});
const { generateHouseworkSchedule }=await import('../src/domain/scheduling/engine.ts');
const { optimizeLaundryScheduleForWeather }=await import('../src/features/weather/optimize-laundry-schedule.ts');
const { addDays }=await import('../src/domain/scheduling/local-date.ts');
test('weather suitability remains enforced when Calendar prefers a rainy day',async()=>{
 const today='2026-10-25';
 const chore={id:'laundry',householdId:'home',name:'洗濯',category:'洗濯',enabled:true,load:'normal',holidayPriority:false,
  laundryDryingPreference:'outdoors',frequencyDaysByMode:{frequent:7,balanced:7,relaxed:7},windowRadiusDays:0,maxShiftDays:2};
 const input={householdId:'home',from:today,through:'2026-11-30',today,chores:[chore],
  states:[{choreId:chore.id,lastCompletedDate:'2026-10-20',initialPending:false}],
  assignments:[],dependencies:[],completions:[],settings:{frequencyMode:'balanced',restDays:[],loadLimits:{heavyDailyLimit:1,normalDailyLimit:2}},
  externalAvailabilityByDate:{'2026-10-27':{busyMinutes:1440}}};
 const schedule=generateHouseworkSchedule(input);assert.equal(schedule[0].suggestedDate,'2026-10-26');
 const forecast=Array.from({length:7},(_,offset)=>({date:addDays(today,offset),weatherCode:0,precipitationProbability:0,precipitationMm:0}));
 forecast[1]={...forecast[1],weatherCode:61,precipitationProbability:90,precipitationMm:20};
 const output=await optimizeLaundryScheduleForWeather({...input,schedule,location:{region:'test',displayName:'test',latitude:35,longitude:139}},
  {fetchForecast:async()=>forecast});
 assert.equal(output.outcome,'adjusted');assert.notEqual(output.schedule[0].suggestedDate,'2026-10-26');
 const failed=await optimizeLaundryScheduleForWeather({...input,schedule,location:{region:'test',displayName:'test',latitude:35,longitude:139}},
  {fetchForecast:async()=>{throw new Error('offline');}});
 assert.deepEqual(failed.schedule,schedule);
});

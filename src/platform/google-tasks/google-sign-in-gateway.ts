import { AppState, Platform } from 'react-native';

import { getGoogleSyncOAuthConfig } from '@/features/google-sync/google-oauth-config';
import { GOOGLE_TASKS_SCOPE } from './google-tasks-api';
import { CalendarPermissionRequiredError, GOOGLE_CALENDAR_FREEBUSY_SCOPE } from '@/features/google-sync/calendar-availability';
import { authorizeCalendarAvailability } from '@/features/google-sync/calendar-authorization';

export class GoogleOAuthConfigurationError extends Error {
  constructor() {
    super('Google OAuth client IDs are not configured');
    this.name = 'GoogleOAuthConfigurationError';
  }
}

export class GoogleSignInRequiredError extends Error {
  constructor() {
    super('Google sign-in is required');
    this.name = 'GoogleSignInRequiredError';
  }
}

export class GoogleAuthorizationCancelledError extends Error {
  constructor() {
    super('Google Tasks authorization was cancelled');
    this.name = 'GoogleAuthorizationCancelledError';
  }
}

type GoogleSignInModule = typeof import('react-native-nitro-google-signin');
type GoogleUser = ReturnType<GoogleSignInModule['GoogleOneTapSignIn']['getCurrentUser']>;

function redactDiagnostic(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/https?:\/\/\S+/gu, '[url]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu, '[email]')
    .replace(/\b(?:eyJ|ya29\.|GOCSPX-)[\w.-]+/gu, '[credential]')
    .replace(/(["']?(?:access[_-]?token|refresh[_-]?token|id[_-]?token|serverAuthCode|client_secret|authorization|code|state)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}&]+)/giu, '$1[redacted]')
    .replace(/[A-Za-z0-9_=-]{48,}/gu, '[redacted]')
    .slice(0, 500);
}

async function authStep<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      const error = typeof cause === 'object' && cause !== null
        ? cause as { name?: unknown; code?: unknown; message?: unknown }
        : { message: cause };
      console.warn('[google-auth]', {
        stage,
        name: redactDiagnostic(error.name),
        code: redactDiagnostic(error.code),
        message: redactDiagnostic(error.message),
      });
    }
    throw cause;
  }
}

let configuredModule: GoogleSignInModule | null = null;
let restoringSession: Promise<GoogleUser> | null = null;

async function loadGoogleSignIn(): Promise<GoogleSignInModule> {
  const { configured, webClientId, iosClientId } = getGoogleSyncOAuthConfig();
  if (!configured || !webClientId || !iosClientId) throw new GoogleOAuthConfigurationError();
  const module = await authStep('load-module', () => {
    // Use the package's CommonJS entry: Metro's dynamic import loses its named exports.
    // Keep loading lazy so web and non-native consumers do not initialize Nitro.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-nitro-google-signin') as GoogleSignInModule;
  });
  if (configuredModule !== module) {
    await authStep('configure', () => module.GoogleOneTapSignIn.configure({
      webClientId,
      iosClientId,
      offlineAccess: false,
      scopes: [GOOGLE_TASKS_SCOPE],
    }));
    configuredModule = module;
  }
  return module;
}

async function getCurrentGoogleUser(module: GoogleSignInModule): Promise<GoogleUser> {
  const currentUser = module.GoogleOneTapSignIn.getCurrentUser();
  if (currentUser || Platform.OS !== 'ios') return currentUser;

  // iOS currentUser starts empty after a process restart. Its signIn path silently
  // restores Keychain credentials; Android signIn may show UI, so never use it here.
  if (!restoringSession) {
    restoringSession = authStep('restore-session', () => module.GoogleOneTapSignIn.signIn())
      .then((response) => module.isSuccessResponse(response) ? response.data : null)
      .finally(() => { restoringSession = null; });
  }
  return restoringSession;
}

export async function authorizeGoogleTasks(): Promise<void> {
  const module = await loadGoogleSignIn();
  const googleSignIn = module.GoogleOneTapSignIn;
  await authStep('check-services', () => googleSignIn.checkPlayServices());

  let response = await authStep('restore-session', () => googleSignIn.signIn());
  if (module.isNoSavedCredentialFoundResponse(response)) {
    response = await authStep('interactive-sign-in', () => googleSignIn.createAccount());
  }
  if (module.isCancelledResponse(response)) throw new GoogleAuthorizationCancelledError();
  if (!module.isSuccessResponse(response)) {
    response = await authStep('explicit-sign-in', () => googleSignIn.presentExplicitSignIn());
  }
  if (module.isCancelledResponse(response) || !module.isSuccessResponse(response)) {
    throw new GoogleAuthorizationCancelledError();
  }

  const currentUser = await authStep('current-session', () => googleSignIn.getCurrentUser());
  if (!currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE)) {
    const authorization = await authStep('request-scopes', () => googleSignIn.requestScopes([GOOGLE_TASKS_SCOPE]));
    if (!authorization.accessToken) throw new GoogleAuthorizationCancelledError();
  }
  await authStep('get-tokens', () => googleSignIn.getTokens());
}

export async function getGoogleTasksAccessToken(): Promise<string> {
  const module = await loadGoogleSignIn();
  const currentUser = await getCurrentGoogleUser(module);
  if (!currentUser) throw new GoogleSignInRequiredError();
  if (!currentUser.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleSignInRequiredError();
  return (await authStep('get-tokens', () => module.GoogleOneTapSignIn.getTokens())).accessToken;
}

export async function hasGoogleTasksSession(): Promise<boolean> {
  try {
    const module = await loadGoogleSignIn();
    const currentUser = await getCurrentGoogleUser(module);
    return Boolean(currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE));
  } catch {
    return false;
  }
}

/** Incremental consent is only invoked by the settings ON/retry button. */
export async function authorizeGoogleCalendarAvailability(): Promise<void> {
  if (AppState.currentState !== 'active') throw new CalendarPermissionRequiredError();
  const module = await loadGoogleSignIn();
  const current = await getCurrentGoogleUser(module);
  if (!current?.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new CalendarPermissionRequiredError();
  await authorizeCalendarAvailability({
    grantedScopes: async () => (await getCurrentGoogleUser(module))?.scopes ?? [],
    requestScopes: (scopes) => authStep('request-calendar-scope', () => module.GoogleOneTapSignIn.requestScopes(scopes)),
  });
}

/** Non-interactive: no requestScopes/createAccount/presentExplicitSignIn fallback. */
export async function getGoogleCalendarAccessToken(): Promise<string> {
  const module = await loadGoogleSignIn();
  const user = await getCurrentGoogleUser(module);
  if (!user?.scopes.includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) throw new CalendarPermissionRequiredError();
  const tokens = await authStep('get-calendar-token', () => module.GoogleOneTapSignIn.getTokens());
  // Android can silently fall back to the still-granted Tasks scope after Calendar revocation.
  if (!(await getCurrentGoogleUser(module))?.scopes.includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) {
    throw new CalendarPermissionRequiredError();
  }
  return tokens.accessToken;
}

export async function disconnectGoogleTasksSession(): Promise<void> {
  const module = await loadGoogleSignIn();
  const googleSignIn = module.GoogleOneTapSignIn;
  try {
    const currentUser = await getCurrentGoogleUser(module);
    if (currentUser) await googleSignIn.revokeAccess(currentUser.user.id);
  } finally {
    await googleSignIn.signOut();
  }
}

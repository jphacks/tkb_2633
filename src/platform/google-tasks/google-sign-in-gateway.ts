import { getGoogleSyncOAuthConfig } from '@/features/google-sync/google-oauth-config';
import { GOOGLE_TASKS_SCOPE } from './google-tasks-api';

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
  const { GoogleOneTapSignIn: googleSignIn } = await loadGoogleSignIn();
  const currentUser = googleSignIn.getCurrentUser();
  if (!currentUser) throw new GoogleSignInRequiredError();
  if (!currentUser.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleSignInRequiredError();
  return (await googleSignIn.getTokens()).accessToken;
}

export async function hasGoogleTasksSession(): Promise<boolean> {
  try {
    const { GoogleOneTapSignIn: googleSignIn } = await loadGoogleSignIn();
    const currentUser = googleSignIn.getCurrentUser();
    return Boolean(currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE));
  } catch {
    return false;
  }
}

export async function disconnectGoogleTasksSession(): Promise<void> {
  const { GoogleOneTapSignIn: googleSignIn } = await loadGoogleSignIn();
  const currentUser = googleSignIn.getCurrentUser();
  try {
    if (currentUser) await googleSignIn.revokeAccess(currentUser.user.id);
  } finally {
    await googleSignIn.signOut();
  }
}

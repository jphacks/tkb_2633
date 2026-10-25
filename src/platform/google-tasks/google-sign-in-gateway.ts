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

interface GoogleSignInModule {
  GoogleOneTapSignIn: {
    configure(options: { webClientId: string; iosClientId: string; offlineAccess: false; scopes: string[] }): void;
    checkPlayServices(): Promise<void>;
    signIn(): Promise<{ type: string; data: { user: { id: string }; scopes: string[] } | null }>;
    createAccount(): Promise<{ type: string; data: { user: { id: string }; scopes: string[] } | null }>;
    presentExplicitSignIn(): Promise<{ type: string; data: { user: { id: string }; scopes: string[] } | null }>;
    requestScopes(scopes: string[]): Promise<{ accessToken: string | null }>;
    getCurrentUser(): { user: { id: string }; scopes: string[] } | null;
    getTokens(): Promise<{ accessToken: string }>;
    signOut(): Promise<void>;
    revokeAccess(emailOrUniqueId: string): Promise<void>;
  };
  isNoSavedCredentialFoundResponse(response: { type: string }): boolean;
  isCancelledResponse(response: { type: string }): boolean;
  isSuccessResponse(response: { type: string; data: unknown }): boolean;
}

let configuredModule: GoogleSignInModule | null = null;

async function loadGoogleSignIn(): Promise<GoogleSignInModule['GoogleOneTapSignIn']> {
  const config = getGoogleSyncOAuthConfig();
  if (!config.configured || !config.webClientId || !config.iosClientId) throw new GoogleOAuthConfigurationError();
  const module = await import('react-native-nitro-google-signin') as GoogleSignInModule;
  if (configuredModule !== module) {
    module.GoogleOneTapSignIn.configure({
      webClientId: config.webClientId,
      iosClientId: config.iosClientId,
      offlineAccess: false,
      scopes: [GOOGLE_TASKS_SCOPE],
    });
    configuredModule = module;
  }
  return module.GoogleOneTapSignIn;
}

export async function authorizeGoogleTasks(): Promise<void> {
  const googleSignIn = await loadGoogleSignIn();
  await googleSignIn.checkPlayServices();

  const module = await import('react-native-nitro-google-signin') as GoogleSignInModule;
  let response = await googleSignIn.signIn();
  if (module.isNoSavedCredentialFoundResponse(response)) response = await googleSignIn.createAccount();
  if (module.isCancelledResponse(response)) throw new GoogleAuthorizationCancelledError();
  if (!module.isSuccessResponse(response)) response = await googleSignIn.presentExplicitSignIn();
  if (module.isCancelledResponse(response) || !module.isSuccessResponse(response)) {
    throw new GoogleAuthorizationCancelledError();
  }

  const currentUser = googleSignIn.getCurrentUser();
  if (!currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE)) {
    const authorization = await googleSignIn.requestScopes([GOOGLE_TASKS_SCOPE]);
    if (!authorization.accessToken) throw new GoogleAuthorizationCancelledError();
  }
  await googleSignIn.getTokens();
}

export async function getGoogleTasksAccessToken(): Promise<string> {
  const googleSignIn = await loadGoogleSignIn();
  const currentUser = googleSignIn.getCurrentUser();
  if (!currentUser) throw new GoogleSignInRequiredError();
  if (!currentUser.scopes.includes(GOOGLE_TASKS_SCOPE)) throw new GoogleSignInRequiredError();
  return (await googleSignIn.getTokens()).accessToken;
}

export async function hasGoogleTasksSession(): Promise<boolean> {
  try {
    const googleSignIn = await loadGoogleSignIn();
    const currentUser = googleSignIn.getCurrentUser();
    return Boolean(currentUser?.scopes.includes(GOOGLE_TASKS_SCOPE));
  } catch {
    return false;
  }
}

export async function disconnectGoogleTasksSession(): Promise<void> {
  const googleSignIn = await loadGoogleSignIn();
  const currentUser = googleSignIn.getCurrentUser();
  try {
    if (currentUser) await googleSignIn.revokeAccess(currentUser.user.id);
  } finally {
    await googleSignIn.signOut();
  }
}

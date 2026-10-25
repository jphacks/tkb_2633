import Constants from 'expo-constants';

export interface GoogleSyncOAuthConfig {
  webClientId: string | null;
  iosClientId: string | null;
  configured: boolean;
}

export function getGoogleSyncOAuthConfig(): GoogleSyncOAuthConfig {
  const extra = Constants.expoConfig?.extra?.googleSyncOAuth as Partial<GoogleSyncOAuthConfig> | undefined;
  return {
    webClientId: typeof extra?.webClientId === 'string' ? extra.webClientId : null,
    iosClientId: typeof extra?.iosClientId === 'string' ? extra.iosClientId : null,
    configured: extra?.configured === true,
  };
}

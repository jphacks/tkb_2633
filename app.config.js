module.exports = ({ config }) => {
  const appleTeamId = process.env.APPLE_TEAM_ID?.trim() || null;
  if (appleTeamId && !/^[A-Z0-9]{10}$/.test(appleTeamId)) {
    throw new Error('APPLE_TEAM_ID must be a 10-character Apple development team ID.');
  }
  const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID?.trim()
    || process.env.GOOGLE_WEB_CLIENT_ID?.trim() || null;
  const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID?.trim()
    || process.env.GOOGLE_IOS_CLIENT_ID?.trim() || null;
  const iosClientIdSuffix = '.apps.googleusercontent.com';
  if (iosClientId && !iosClientId.endsWith(iosClientIdSuffix)) {
    throw new Error('EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID must be a Google OAuth client ID.');
  }
  const iosUrlScheme = process.env.GOOGLE_IOS_REVERSED_CLIENT_ID?.trim()
    || (iosClientId ? `com.googleusercontent.apps.${iosClientId.slice(0, -iosClientIdSuffix.length)}` : null);
  const hasNativeGoogleConfiguration = Boolean(webClientId && iosClientId && iosUrlScheme);
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin[0];
    return name !== 'react-native-nitro-google-signin';
  });

  if (hasNativeGoogleConfiguration) {
    plugins.push(['react-native-nitro-google-signin', { iosUrlScheme }]);
    plugins.push('./plugins/with-google-sign-in-redirect');
  }

  return {
    ...config,
    ios: {
      ...config.ios,
      ...(appleTeamId ? { appleTeamId } : {}),
    },
    plugins,
    extra: {
      ...config.extra,
      googleSyncOAuth: {
        webClientId,
        iosClientId,
        configured: hasNativeGoogleConfiguration,
      },
    },
  };
};

module.exports = ({ config }) => {
  const webClientId = process.env.GOOGLE_WEB_CLIENT_ID?.trim() || null;
  const iosClientId = process.env.GOOGLE_IOS_CLIENT_ID?.trim() || null;
  const iosUrlScheme = process.env.GOOGLE_IOS_REVERSED_CLIENT_ID?.trim() || null;
  const hasNativeGoogleConfiguration = Boolean(webClientId && iosClientId && iosUrlScheme);
  const plugins = (config.plugins ?? []).filter((plugin) => {
    const name = typeof plugin === 'string' ? plugin : plugin[0];
    return name !== 'react-native-nitro-google-signin';
  });

  if (hasNativeGoogleConfiguration) {
    plugins.push(['react-native-nitro-google-signin', { iosUrlScheme }]);
  }

  return {
    ...config,
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

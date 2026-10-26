const { withEntitlementsPlist, withRunOnce } = require('expo/config-plugins');

/** Expo automatically applies this package's plugin even when it is not listed. */
function withOptionalAppleSignIn(config, { enabled = false } = {}) {
  if (enabled) {
    const applePlugin = require('expo-apple-authentication/app.plugin');
    return (applePlugin.default ?? applePlugin)(config);
  }
  config.ios = { ...config.ios, usesAppleSignIn: false };
  return withRunOnce(config, {
    name: 'expo-apple-authentication',
    version: require('expo-apple-authentication/package.json').version,
    plugin: (result) => withEntitlementsPlist(result, (mod) => {
      delete mod.modResults['com.apple.developer.applesignin'];
      return mod;
    }),
  });
}

module.exports = withOptionalAppleSignIn;

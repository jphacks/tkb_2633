const { withAppDelegate } = require('@expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

function addGoogleSignInRedirect(source) {
  if (source.includes('GIDSignIn.sharedInstance.handle(url)')) return source;
  if (/func application\([\s\S]*?\bopen url: URL/u.test(source)) {
    throw new Error('Google Sign-In redirect: an existing open-URL handler must call GIDSignIn before this plugin can be applied.');
  }
  const contents = source.includes('import GoogleSignIn') ? source : `import GoogleSignIn\n${source}`;
  return mergeContents({
    tag: 'google-sign-in-open-url',
    src: contents,
    anchor: /class AppDelegate[^\n]*\{/u,
    offset: 1,
    comment: '//',
    newSrc: `  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if GIDSignIn.sharedInstance.handle(url) { return true }
    return super.application(app, open: url, options: options)
  }
`,
  }).contents;
}

function withGoogleSignInRedirect(config) {
  return withAppDelegate(config, (result) => {
    if (result.modResults.language !== 'swift') {
      throw new Error('Google Sign-In redirect requires the Expo SDK 58 Swift AppDelegate.');
    }
    result.modResults.contents = addGoogleSignInRedirect(result.modResults.contents);
    return result;
  });
}

module.exports = withGoogleSignInRedirect;
module.exports.addGoogleSignInRedirect = addGoogleSignInRedirect;

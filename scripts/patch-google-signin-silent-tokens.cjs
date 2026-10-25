const fs = require('node:fs');
const path = require('node:path');

function patchSilentTokens(controller, helper) {
  const start = controller.indexOf('  suspend fun getTokens():');
  const end = controller.indexOf('  suspend fun clearCachedAccessToken(', start);
  if (start < 0 || end < 0) throw new Error('Unsupported Google Sign-In getTokens implementation');
  let tokens = controller.slice(start, end);
  if (!tokens.includes('allowResolution = false')) {
    if (!tokens.includes('offlineAccess = false,')) throw new Error('Google Sign-In token authorization call was not found');
    tokens = tokens.replace('offlineAccess = false,', 'offlineAccess = false,\n        allowResolution = false,');
  }
  if (!tokens.includes('val baseScopes = (configuredScopes + DEFAULT_AUTHORIZATION_SCOPES).distinct()')) {
    const authorizeStart = tokens.indexOf('    val authResult =\n');
    const authorizeEnd = tokens.indexOf('\n    val accessToken =', authorizeStart);
    const call = tokens.slice(authorizeStart, authorizeEnd);
    if (authorizeStart < 0 || authorizeEnd < 0 || !call.includes('GoogleSignInAuthorizationHelper.authorize(')
      || !call.includes('scopes = scopes,') || !call.includes('allowResolution = false,')) {
      throw new Error('Google Sign-In silent token authorization call changed');
    }
    tokens = tokens.slice(0, authorizeStart) + `    val authResult =
      try {
        GoogleSignInAuthorizationHelper.authorize(
          activity = requireActivity(),
          context = context,
          serverClientId = webClientId!!,
          scopes = scopes,
          offlineAccess = false,
          allowResolution = false,
          accountEmail = accountEmail,
        )
      } catch (error: GoogleSignInException) {
        // A revoked optional permission must not block the configured core feature.
        val baseScopes = (configuredScopes + DEFAULT_AUTHORIZATION_SCOPES).distinct()
        if (error.code != "SIGN_IN_REQUIRED" || scopes.toSet() == baseScopes.toSet()) throw error
        val baseResult = GoogleSignInAuthorizationHelper.authorize(
          activity = requireActivity(),
          context = context,
          serverClientId = webClientId!!,
          scopes = baseScopes,
          offlineAccess = false,
          allowResolution = false,
          accountEmail = accountEmail,
        )
        saveScopesToStorage(context, lastUserId, baseScopes.toSet())
        baseResult
      }
` + tokens.slice(authorizeEnd);
  }
  controller = controller.slice(0, start) + tokens + controller.slice(end);
  if (!helper.includes('allowResolution: Boolean = true')) {
    const parameter = '    accountEmail: String? = null,';
    if (!helper.includes(parameter)) throw new Error('Google Sign-In authorization parameters changed');
    helper = helper.replace(parameter, parameter + '\n    allowResolution: Boolean = true,');
  }
  if (!helper.includes('if (!allowResolution)')) {
    const branch = '        if (initial.hasResolution()) {';
    if (!helper.includes(branch)) throw new Error('Google Sign-In authorization resolution branch changed');
    helper = helper.replace(branch, branch + `
          // Automatic token refresh must never launch an authorization dialog.
          if (!allowResolution) {
            throw GoogleSignInException(
              code = "SIGN_IN_REQUIRED",
              message = "Additional authorization requires an explicit foreground action.",
            )
          }`);
  }
  return { controller, helper };
}

module.exports = { patchSilentTokens };
if (require.main === module) {
  const base = path.join(__dirname, '../node_modules/react-native-nitro-google-signin/android/src/main/java/com/nitrogooglesignin');
  const controllerPath = path.join(base, 'GoogleSignInController.kt');
  const helperPath = path.join(base, 'GoogleSignInAuthorizationHelper.kt');
  if (fs.existsSync(controllerPath) && fs.existsSync(helperPath)) {
    const originalController = fs.readFileSync(controllerPath, 'utf8');
    const originalHelper = fs.readFileSync(helperPath, 'utf8');
    const patched = patchSilentTokens(originalController, originalHelper);
    if (patched.controller !== originalController) fs.writeFileSync(controllerPath, patched.controller);
    if (patched.helper !== originalHelper) fs.writeFileSync(helperPath, patched.helper);
  }
}

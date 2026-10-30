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
  if (!tokens.includes('val preservedTaskScopes = scopes.filter')) {
    const authorizeStart = tokens.indexOf('    val authResult =\n');
    const authorizeEnd = tokens.indexOf('\n    val accessToken =', authorizeStart);
    const call = tokens.slice(authorizeStart, authorizeEnd);
    if (authorizeStart < 0 || authorizeEnd < 0 || !call.includes('GoogleSignInAuthorizationHelper.authorize(')
      || !call.includes('scopes = scopes,') || !call.includes('allowResolution = false,')) {
      throw new Error('Google Sign-In silent token authorization call changed');
    }
    tokens = tokens.slice(0, authorizeStart) + `    suspend fun authorizeSilently(requestedScopes: List<String>) =
      GoogleSignInAuthorizationHelper.authorize(
        activity = requireActivity(),
        context = context,
        serverClientId = webClientId!!,
        scopes = requestedScopes,
        offlineAccess = false,
        allowResolution = false,
        accountEmail = accountEmail,
      )

    val authResult =
      try {
        authorizeSilently(scopes)
      } catch (error: GoogleSignInException) {
        // Calendar revocation must preserve a still-authorized Tasks session even
        // when the app's basic sign-in configuration only requests identity.
        val baseScopes = (configuredScopes + DEFAULT_AUTHORIZATION_SCOPES).distinct()
        if (error.code != "SIGN_IN_REQUIRED" || scopes.toSet() == baseScopes.toSet()) throw error
        val preservedTaskScopes = scopes.filter { it == "https://www.googleapis.com/auth/tasks" }
        val fallbackScopes = (baseScopes + preservedTaskScopes).distinct()
        if (fallbackScopes.toSet() != scopes.toSet() && fallbackScopes.toSet() != baseScopes.toSet()) {
          try {
            val result = authorizeSilently(fallbackScopes)
            saveScopesToStorage(context, lastUserId, fallbackScopes.toSet())
            result
          } catch (fallbackError: GoogleSignInException) {
            if (fallbackError.code != "SIGN_IN_REQUIRED") throw fallbackError
            val result = authorizeSilently(baseScopes)
            saveScopesToStorage(context, lastUserId, baseScopes.toSet())
            result
          }
        } else {
          val result = authorizeSilently(baseScopes)
          saveScopesToStorage(context, lastUserId, baseScopes.toSet())
          result
        }
      }
` + tokens.slice(authorizeEnd);
  }
  tokens = tokens.replaceAll('activity = requireActivity(),', 'activity = context.currentActivity,');
  controller = controller.slice(0, start) + tokens + controller.slice(end);
  const initialScopes = 'val initialScopes = (configuredScopes + DEFAULT_AUTHORIZATION_SCOPES).toSet()';
  if (controller.includes(initialScopes)) {
    controller = controller.replace(initialScopes,
      'val initialScopes = (getScopesFromStorage(requireContext(), userId) + configuredScopes + DEFAULT_AUTHORIZATION_SCOPES).toSet()');
  }
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
  if (!helper.includes('    activity: Activity?,\n    context: ReactApplicationContext,')) {
    const parameters = '    activity: Activity,\n    context: ReactApplicationContext,';
    if (!helper.includes(parameters)) throw new Error('Google Sign-In authorization activity signature changed');
    helper = helper.replace(parameters, '    activity: Activity?,\n    context: ReactApplicationContext,');
  }
  if (!helper.includes('else Identity.getAuthorizationClient(context)')) {
    const client = 'val authClient = Identity.getAuthorizationClient(activity)';
    if (!helper.includes(client)) throw new Error('Google Sign-In authorization client initialization changed');
    helper = helper.replace(client, 'val authClient = if (activity != null) Identity.getAuthorizationClient(activity) else Identity.getAuthorizationClient(context)');
  }
  if (!helper.includes('val foregroundActivity = activity')) {
    const resolution = 'awaitAuthorizationResolution(activity, pendingIntent.intentSender)';
    if (!helper.includes(resolution)) throw new Error('Google Sign-In foreground resolution call changed');
    helper = helper.replace(resolution, `val foregroundActivity = activity ?: throw GoogleSignInException(
            code = "NO_ACTIVITY",
            message = "Authorization UI requires a foreground Activity.",
          )
          awaitAuthorizationResolution(foregroundActivity, pendingIntent.intentSender)`);
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

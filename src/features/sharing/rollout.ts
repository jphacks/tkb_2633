/** New groups use v2. Explicit false is a deployment rollback switch, never an existing-data conversion. */
export function sharingCreationProtocol(value = process.env.EXPO_PUBLIC_SHARING_V2_ENABLED): 1 | 2 {
  return value === 'false' ? 1 : 2;
}

/** The standard Rules include recovery. Older deployments can explicitly disable the extra requests. */
export function sharingOwnerRecoveryEnabled(value = process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY): boolean {
  return value !== 'false';
}

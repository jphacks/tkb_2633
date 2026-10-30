/** Normal creation is v2 only. Legacy wire readers exist solely to preserve signed migration evidence. */
export function sharingCreationProtocol(_value?: string): 2 { return 2; }

/** The standard Rules include recovery. Older deployments can explicitly disable the extra requests. */
export function sharingOwnerRecoveryEnabled(value = process.env.EXPO_PUBLIC_SHARING_OWNER_RECOVERY): boolean {
  return value !== 'false';
}

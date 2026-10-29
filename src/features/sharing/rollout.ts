/** Public build capability only. Enabling it follows the verified Rules deployment/release decision. */
export function sharingCreationProtocol(value = process.env.EXPO_PUBLIC_SHARING_V2_ENABLED): 1 | 2 {
  return value === 'true' ? 2 : 1;
}

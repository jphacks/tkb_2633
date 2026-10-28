const OFFICIAL_DOMAINS: Readonly<Record<string, readonly string[]>> = {
  dyson: ['dyson.co.jp'],
  ダイソン: ['dyson.co.jp'],
  panasonic: ['panasonic.jp'],
  パナソニック: ['panasonic.jp'],
  hitachi: ['kadenfan.hitachi.co.jp'],
  日立: ['kadenfan.hitachi.co.jp'],
  sharp: ['jp.sharp'],
  シャープ: ['jp.sharp'],
};

/** Japanese and English names for the same supported manufacturer share one identity. */
export const applianceManufacturerIdentity = (manufacturer: string): string | null =>
  OFFICIAL_DOMAINS[manufacturer.normalize('NFKC').trim().toLocaleLowerCase('en-US')]?.[0] ?? null;

/** Only open an HTTPS URL on the configured Japanese manufacturer's official host. */
export function isOfficialApplianceUrl(value: string, manufacturer: string): boolean {
  if (value.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const domains = OFFICIAL_DOMAINS[manufacturer.normalize('NFKC').trim().toLocaleLowerCase('en-US')] ?? [];
  const hostname = url.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
  return domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

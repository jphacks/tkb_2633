interface ProductName {
  manufacturer: string;
  productName: string;
  modelNumber?: string;
}

/** Official product names sometimes already include the manufacturer. */
export function applianceDisplayName(product: ProductName, savedDisplayName?: string): string {
  const legacyName = `${product.manufacturer} ${product.productName}${product.modelNumber ? `（${product.modelNumber}）` : ''}`;
  // Format old generated names on read, without rewriting source records or custom labels.
  if (savedDisplayName !== undefined && savedDisplayName !== legacyName) return savedDisplayName;
  const manufacturer = product.manufacturer.trim();
  const name = product.productName.trim();
  const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').toLowerCase();
  const normalizedName = normalize(name);
  const normalizedManufacturer = normalize(manufacturer);
  const includesManufacturer = normalizedName === normalizedManufacturer
    || normalizedName.startsWith(`${normalizedManufacturer} `);
  const title = !manufacturer || includesManufacturer ? name : `${manufacturer} ${name}`;
  return `${title}${product.modelNumber ? `（${product.modelNumber}）` : ''}`;
}

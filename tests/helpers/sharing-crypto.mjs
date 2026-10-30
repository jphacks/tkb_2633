import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Independent Node/OpenSSL implementation checks the portable wire format. */
export const sharingTestCrypto = {
  async randomBytes(length) { return new Uint8Array(randomBytes(length)); },
  async encrypt(key, nonce, plaintext, aad) {
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    return new Uint8Array(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  },
  async decrypt(key, nonce, combined, aad) {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce); decipher.setAAD(aad);
    decipher.setAuthTag(combined.slice(-16));
    return new Uint8Array(Buffer.concat([decipher.update(combined.slice(0, -16)), decipher.final()]));
  },
};

import createQrCode from 'qrcode-generator';
import { parseSharedInvitation } from './invitations.ts';

/** Generated locally: invitation secrets never go to an online QR service. */
export function sharingInvitationQr(url: string, now = Date.now()): { uri: string; modules: number } {
  parseSharedInvitation(url, now);
  const code = createQrCode(0, 'M'); code.addData(url, 'Byte'); code.make();
  // Android's Expo Image data-URI loader accepts base64, not percent-encoded SVG.
  // The library emits a local, static GIF with a four-module quiet zone on both OSes.
  return { uri: code.createDataURL(4, 16), modules: code.getModuleCount() };
}

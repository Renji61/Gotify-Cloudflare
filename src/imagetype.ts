// Detects whether the first bytes of a file are an image, like
// github.com/h2non/filetype's IsImage (which upstream uses on the first 261
// bytes of an uploaded file). Magic numbers only; the file extension is checked
// separately, as upstream does.

function startsWith(buf: Uint8Array, ...bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

function ascii(buf: Uint8Array, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) if (buf[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function ftypBrand(buf: Uint8Array): string | null {
  if (!ascii(buf, 4, 'ftyp') || buf.length < 12) return null;
  return String.fromCharCode(buf[8], buf[9], buf[10], buf[11]);
}

export function isImage(head: Uint8Array): boolean {
  if (startsWith(head, 0xff, 0xd8, 0xff)) return true; // jpeg
  if (startsWith(head, 0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a)) return true; // jpeg 2000
  if (startsWith(head, 0x89, 0x50, 0x4e, 0x47)) return true; // png
  if (startsWith(head, 0x47, 0x49, 0x46)) return true; // gif
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return true; // webp
  if (startsWith(head, 0x49, 0x49, 0x2a, 0x00) || startsWith(head, 0x4d, 0x4d, 0x00, 0x2a)) return true; // tiff (and cr2)
  if (startsWith(head, 0x42, 0x4d)) return true; // bmp
  if (startsWith(head, 0x49, 0x49, 0xbc)) return true; // jpeg xr
  if (startsWith(head, 0x38, 0x42, 0x50, 0x53)) return true; // psd
  if (startsWith(head, 0x00, 0x00, 0x01, 0x00)) return true; // ico
  if (startsWith(head, 0x41, 0x43, 0x31, 0x30)) return true; // dwg
  const brand = ftypBrand(head);
  if (brand !== null && ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) return true; // heif / avif
  return false;
}

/** Content types for the extensions upstream allows for application images. */
export const IMAGE_CONTENT_TYPES: Record<string, string> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** api.ValidApplicationImageExt */
export function validImageExt(ext: string): boolean {
  return Object.hasOwn(IMAGE_CONTENT_TYPES, ext.toLowerCase());
}

/** filepath.Ext: the final dot and everything after it in the last path element. */
export function fileExt(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i);
}

/** Max size for template email images (logos, inline images). */
export const TEMPLATE_MEDIA_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function startsWithBytes(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  return bytes.every((b, i) => buf[i] === b);
}

/**
 * Detect image type from magic bytes. Rejects SVG and non-image payloads.
 */
export function detectTemplateImageMime(buffer: Buffer): string | null {
  if (!buffer || buffer.length < 3) return null;

  const head = buffer.subarray(0, Math.min(512, buffer.length)).toString('utf8').toLowerCase();
  if (
    head.includes('<svg') ||
    head.includes('<?xml') ||
    head.trimStart().startsWith('<!doctype svg')
  ) {
    return null;
  }

  if (startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if (startsWithBytes(buffer, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (startsWithBytes(buffer, [0x47, 0x49, 0x46, 0x38])) {
    return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }

  return null;
}

export function extensionForMime(mime: string): string {
  return EXT_BY_MIME[mime] || 'bin';
}

export function sanitizeOriginalFilename(name: string): string {
  const base = String(name || 'image')
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^\w.\-()+\s]/g, '_')
    .trim()
    .slice(0, 180);
  return base || 'image';
}

export type TemplateMediaValidationResult =
  | { ok: true; mime: string; extension: string }
  | { ok: false; error: string };

export function validateTemplateMediaFile(params: {
  buffer: Buffer;
  declaredMime?: string;
  sizeBytes: number;
}): TemplateMediaValidationResult {
  const { buffer, sizeBytes } = params;

  if (!buffer?.length) {
    return { ok: false, error: 'Dosya boş veya okunamadı' };
  }

  if (sizeBytes > TEMPLATE_MEDIA_MAX_BYTES) {
    const mb = (TEMPLATE_MEDIA_MAX_BYTES / (1024 * 1024)).toFixed(0);
    return {
      ok: false,
      error: `Dosya boyutu ${mb} MB sınırını aşıyor. Daha küçük bir görsel seçin.`,
    };
  }

  const detected = detectTemplateImageMime(buffer);
  if (!detected || !ALLOWED_MIME.has(detected)) {
    return {
      ok: false,
      error:
        'Desteklenmeyen dosya türü. Yalnızca PNG, JPG, WEBP veya GIF yükleyebilirsiniz. SVG kabul edilmez.',
    };
  }

  const declared = String(params.declaredMime || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== detected && !declared.startsWith('image/')) {
    return { ok: false, error: 'Geçersiz dosya türü' };
  }

  return { ok: true, mime: detected, extension: extensionForMime(detected) };
}

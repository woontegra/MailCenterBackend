/** Strip dangerous tags/attributes from email HTML while preserving layout styles. */

const DANGEROUS_TAGS =
  /<\/?(?:script|iframe|object|embed|form|link|meta|base|svg|math|frame|frameset|applet)(?:\s[^>]*)?>/gi;

const EVENT_ATTR = /\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;

function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith('#') || url.startsWith('mailto:');
}

function isSafeImageDataUrl(url: string): boolean {
  return /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/i.test(url);
}

function sanitizeHrefOrSrc(raw: string, kind: 'href' | 'src'): string {
  const value = String(raw || '').trim();
  if (!value) return '';

  const lower = value.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:')) return '';
  if (lower.startsWith('data:')) {
    if (kind === 'src' && isSafeImageDataUrl(value)) return value;
    return '';
  }
  if (kind === 'href') {
    if (isSafeHttpUrl(value) || value.startsWith('{{')) return value.replace(/javascript:/gi, '');
    if (value.startsWith('/')) return value;
    return `https://${value.replace(/^\/+/, '')}`;
  }
  // src: https images (and rewritten cid data URLs already handled)
  if (/^https:\/\//i.test(value)) return value;
  if (/^http:\/\//i.test(value)) return value; // allow http remote images; product shows remote images by default
  return '';
}

function rewriteUrlsInTag(tag: string): string {
  return tag.replace(
    /\s(href|src|xlink:href)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (_full, attr: string, _quoted: string, d1?: string, d2?: string, bare?: string) => {
      const raw = d1 ?? d2 ?? bare ?? '';
      const kind = String(attr).toLowerCase() === 'href' ? 'href' : 'src';
      const safe = sanitizeHrefOrSrc(raw, kind);
      if (!safe) return '';
      const escaped = safe.replace(/"/g, '&quot;');
      let out = ` ${attr}="${escaped}"`;
      if (kind === 'href') {
        if (!/\starget\s*=/i.test(tag)) out += ' target="_blank"';
        if (!/\srel\s*=/i.test(tag)) out += ' rel="noopener noreferrer"';
      }
      return out;
    }
  );
}

/**
 * Sanitize inbound/outbound email HTML for safe display.
 * Keeps table layouts, inline styles, colors, and safe images.
 */
export function sanitizeEmailHtmlFragment(html: string): string {
  let out = String(html || '');
  if (!out.trim()) return '';

  // Remove complete dangerous elements and their content where applicable
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed[\s\S]*?>/gi, '');
  out = out.replace(/<form[\s\S]*?<\/form>/gi, '');
  out = out.replace(/<base[\s\S]*?>/gi, '');
  out = out.replace(/<meta[\s\S]*?>/gi, '');
  out = out.replace(/<link[\s\S]*?>/gi, '');

  // Drop remaining dangerous open/close tags
  out = out.replace(DANGEROUS_TAGS, '');

  // Neutralize event handlers and javascript: anywhere
  out = out.replace(EVENT_ATTR, '');
  out = out.replace(/javascript:/gi, '');
  out = out.replace(/vbscript:/gi, '');
  out = out.replace(/expression\s*\(/gi, '');

  // Strip style blocks that can affect the host page if not sandboxed;
  // keep inline style attributes on elements (email layouts rely on them).
  out = out.replace(/<style[\s\S]*?<\/style>/gi, '');

  // Sanitize url-bearing attributes tag by tag
  out = out.replace(/<[^>]+>/g, (tag) => {
    if (tag.startsWith('</')) return tag;
    return rewriteUrlsInTag(tag);
  });

  return out;
}

export function sanitizeUrl(url: string): string {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('{{') || trimmed.startsWith('#')) {
    return trimmed.replace(/javascript:/gi, '');
  }
  if (trimmed.startsWith('mailto:')) return trimmed;
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

export function escapeAttr(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Wrap sanitized fragment for sandboxed iframe srcDoc rendering. */
export function wrapEmailHtmlDocument(sanitizedFragment: string): string {
  const body = String(sanitizedFragment || '');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank" rel="noopener noreferrer"><style>
html,body{margin:0;padding:0;background:transparent;color:#1a2332;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere;}
img,video{max-width:100%;height:auto;}
table{max-width:100%;border-collapse:collapse;}
a{word-break:break-word;}
</style></head><body>${body}</body></html>`;
}

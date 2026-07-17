import { escapeHtml } from './templateRenderer';
import { escapeAttr, sanitizeEmailHtmlFragment, sanitizeUrl } from './emailHtmlSanitizer';

export type BlockType =
  | 'heading'
  | 'text'
  | 'image'
  | 'logo'
  | 'button'
  | 'divider'
  | 'spacer'
  | 'columns1'
  | 'columns2'
  | 'columns3'
  | 'social'
  | 'company_info'
  | 'unsubscribe'
  | 'footer';

export type EmailBlock = {
  id: string;
  type: BlockType;
  props: Record<string, unknown>;
  hiddenOnMobile?: boolean;
};

export type EditorDocument = {
  version: 1;
  blocks: EmailBlock[];
  settings?: {
    backgroundColor?: string;
    contentWidth?: number;
    fontFamily?: string;
    primaryColor?: string;
  };
};

export type CompileResult = {
  html: string;
  plainText: string;
  variables: string[];
  warnings: string[];
};

const DEFAULT_WIDTH = 600;

function px(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function alignStyle(align?: unknown): string {
  const a = String(align || 'left');
  if (a === 'center' || a === 'right') return `text-align:${a};`;
  return 'text-align:left;';
}

function paddingStyle(props: Record<string, unknown>): string {
  const pt = px(props.paddingTop, 16);
  const pr = px(props.paddingRight, 24);
  const pb = px(props.paddingBottom, 16);
  const pl = px(props.paddingLeft, 24);
  return `padding:${pt}px ${pr}px ${pb}px ${pl}px;`;
}

function marginStyle(props: Record<string, unknown>): string {
  const mt = px(props.marginTop, 0);
  const mb = px(props.marginBottom, 0);
  return `margin:${mt}px 0 ${mb}px 0;`;
}

function borderStyle(props: Record<string, unknown>): string {
  const width = px(props.borderWidth, 0);
  if (!width) return '';
  const color = escapeAttr(String(props.borderColor || '#e5e7eb'));
  const radius = px(props.borderRadius, 0);
  return `border:${width}px solid ${color};border-radius:${radius}px;`;
}

function bgStyle(props: Record<string, unknown>): string {
  const bg = String(props.backgroundColor || '').trim();
  return bg ? `background-color:${escapeAttr(bg)};` : '';
}

function mobileClass(hidden?: boolean): string {
  return hidden ? 'mc-hide-mobile' : '';
}

function wrapRow(inner: string, props: Record<string, unknown>, hidden?: boolean): string {
  return `<tr class="${mobileClass(hidden)}"><td style="${paddingStyle(props)}${marginStyle(props)}${bgStyle(props)}${borderStyle(props)}${alignStyle(props.align)}">${inner}</td></tr>`;
}

function renderBlockInner(block: EmailBlock, warnings: string[]): string {
  const row = renderBlock(block, warnings);
  const match = row.match(/<td[^>]*>([\s\S]*)<\/td><\/tr>$/);
  return match ? match[1] : row;
}

function renderBlock(block: EmailBlock, warnings: string[]): string {
  const p = block.props || {};

  switch (block.type) {
    case 'heading': {
      const level = Math.min(3, Math.max(1, Number(p.level) || 2));
      const tag = `h${level}`;
      const size = level === 1 ? 28 : level === 2 ? 22 : 18;
      const text = escapeHtml(String(p.text || 'Başlık'));
      const color = escapeAttr(String(p.color || '#15202b'));
      return wrapRow(
        `<${tag} style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:${px(p.fontSize, size)}px;line-height:1.3;color:${color};font-weight:700;">${text}</${tag}>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'text': {
      const raw = String(p.text || '').replace(/\n/g, '<br/>');
      const safe = sanitizeEmailHtmlFragment(raw);
      const color = escapeAttr(String(p.color || '#334155'));
      const fs = px(p.fontSize, 16);
      const lh = px(p.lineHeight, 24);
      return wrapRow(
        `<div style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:${fs}px;line-height:${lh}px;color:${color};">${safe}</div>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'image':
    case 'logo': {
      const src = sanitizeUrl(String(p.src || ''));
      if (!src) {
        return wrapRow(
          `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#94a3b8;">${block.type === 'logo' ? 'Logo' : 'Görsel'} eklenmedi</div>`,
          p,
          block.hiddenOnMobile
        );
      }
      const alt = escapeAttr(String(p.alt || (block.type === 'logo' ? 'Logo' : 'Görsel')));
      const fullWidth = Boolean(p.fullWidth);
      const width = fullWidth ? 560 : Math.min(560, px(p.width, block.type === 'logo' ? 160 : 560));
      const link = sanitizeUrl(String(p.link || ''));
      const widthStyle = fullWidth
        ? 'width:100%;max-width:100%;'
        : `width:${width}px;max-width:100%;`;
      const img = `<img src="${escapeAttr(src)}" alt="${alt}" width="${width}" style="display:block;${widthStyle}height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />`;
      const inner = link
        ? `<a href="${escapeAttr(link)}" style="text-decoration:none;">${img}</a>`
        : img;
      return wrapRow(inner, p, block.hiddenOnMobile);
    }
    case 'button': {
      const text = escapeHtml(String(p.text || 'Buton'));
      const url = sanitizeUrl(String(p.url || '#'));
      const bg = escapeAttr(String(p.bgColor || p.backgroundColor || '#1a2332'));
      const color = escapeAttr(String(p.textColor || '#ffffff'));
      const radius = px(p.borderRadius, 6);
      const py = px(p.paddingY, 12);
      const pxBtn = px(p.paddingX, 24);
      return wrapRow(
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td style="border-radius:${radius}px;background:${bg};"><a href="${escapeAttr(url)}" style="display:inline-block;padding:${py}px ${pxBtn}px;font-family:Arial,Helvetica,sans-serif;font-size:16px;color:${color};text-decoration:none;font-weight:600;">${text}</a></td></tr></table>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'divider':
      return wrapRow(
        `<hr style="border:none;border-top:${px(p.height, 1)}px solid ${escapeAttr(String(p.color || '#e5e7eb'))};margin:0;" />`,
        p,
        block.hiddenOnMobile
      );
    case 'spacer':
      return wrapRow(
        `<div style="height:${px(p.height, 24)}px;line-height:${px(p.height, 24)}px;font-size:1px;">&nbsp;</div>`,
        p,
        block.hiddenOnMobile
      );
    case 'columns1':
    case 'columns2':
    case 'columns3': {
      const cols = Array.isArray(p.columns) ? (p.columns as { blocks?: EmailBlock[] }[]) : [];
      const count = block.type === 'columns3' ? 3 : block.type === 'columns2' ? 2 : 1;
      const widthPct = Math.floor(100 / count);
      const cells = Array.from({ length: count }).map((_, i) => {
        const colBlocks = cols[i]?.blocks || [];
        const inner = colBlocks
          .map((b) => renderBlockInner(b, warnings))
          .join('<div style="height:8px;line-height:8px;font-size:1px;">&nbsp;</div>');
        return `<td width="${widthPct}%" valign="top" style="vertical-align:top;padding:8px;">${inner || '&nbsp;'}</td>`;
      });
      return wrapRow(
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells.join('')}</tr></table>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'social': {
      const links = Array.isArray(p.links) ? (p.links as { label?: string; url?: string }[]) : [];
      const items = links
        .filter((l) => l.url)
        .map(
          (l) =>
            `<a href="${escapeAttr(sanitizeUrl(String(l.url)))}" style="color:#1a2332;text-decoration:none;font-family:Arial,Helvetica,sans-serif;font-size:14px;margin:0 8px;">${escapeHtml(String(l.label || l.url))}</a>`
        )
        .join('');
      return wrapRow(items || '<span style="color:#94a3b8;font-size:14px;">Sosyal bağlantı ekleyin</span>', p, block.hiddenOnMobile);
    }
    case 'company_info': {
      const lines = [
        p.companyName ? `<strong>${escapeHtml(String(p.companyName))}</strong>` : '',
        p.address ? escapeHtml(String(p.address)) : '',
        p.email ? escapeHtml(String(p.email)) : '',
        p.website
          ? `<a href="${escapeAttr(sanitizeUrl(String(p.website)))}" style="color:#1a2332;">${escapeHtml(String(p.website))}</a>`
          : '',
      ].filter(Boolean);
      return wrapRow(
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:20px;color:#64748b;">${lines.join('<br/>')}</div>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'unsubscribe': {
      const link = sanitizeUrl(String(p.link || '{{abonelikten_cikma_linki}}'));
      const text = escapeHtml(String(p.text || 'Bu e-postayı almak istemiyorsanız'));
      const linkText = escapeHtml(String(p.linkText || 'abonelikten çıkın'));
      return wrapRow(
        `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">${text} <a href="${escapeAttr(link)}" style="color:#64748b;">${linkText}</a>.</p>`,
        p,
        block.hiddenOnMobile
      );
    }
    case 'footer': {
      const text = escapeHtml(String(p.text || '© {{marka_adi}}. Tüm hakları saklıdır.'));
      return wrapRow(
        `<p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#94a3b8;">${text}</p>`,
        p,
        block.hiddenOnMobile
      );
    }
    default:
      warnings.push(`Bilinmeyen blok türü: ${block.type}`);
      return '';
  }
}

export function htmlToPlainText(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractVariablesFromDocument(doc: EditorDocument, subject?: string, preheader?: string): string[] {
  const parts: string[] = [subject || '', preheader || ''];
  const walk = (blocks: EmailBlock[]) => {
    for (const b of blocks) {
      parts.push(JSON.stringify(b.props || {}));
      if (b.type === 'columns1' || b.type === 'columns2' || b.type === 'columns3') {
        const cols = Array.isArray(b.props.columns) ? (b.props.columns as { blocks?: EmailBlock[] }[]) : [];
        for (const col of cols) walk(col.blocks || []);
      }
    }
  };
  walk(doc.blocks || []);
  const found = new Set<string>();
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
  for (const part of parts) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(part)) !== null) found.add(m[1]);
  }
  return Array.from(found);
}

export function hasRequiredBulkBlocks(blocks: EmailBlock[]): { company: boolean; unsubscribe: boolean } {
  let company = false;
  let unsubscribe = false;
  const walk = (list: EmailBlock[]) => {
    for (const b of list) {
      if (b.type === 'company_info' || b.type === 'footer') company = true;
      if (b.type === 'unsubscribe') unsubscribe = true;
      if (b.type === 'columns1' || b.type === 'columns2' || b.type === 'columns3') {
        const cols = Array.isArray(b.props.columns) ? (b.props.columns as { blocks?: EmailBlock[] }[]) : [];
        for (const col of cols) walk(col.blocks || []);
      }
    }
  };
  walk(blocks);
  return { company, unsubscribe };
}

export function compileEmailDocument(
  doc: EditorDocument,
  options?: { preheader?: string; subject?: string }
): CompileResult {
  const warnings: string[] = [];
  const width = px(doc.settings?.contentWidth, DEFAULT_WIDTH);
  const bg = escapeAttr(doc.settings?.backgroundColor || '#f4f6f8');
  const font = escapeAttr(doc.settings?.fontFamily || 'Arial,Helvetica,sans-serif');
  const preheader = String(options?.preheader || '').trim();
  const rows = (doc.blocks || []).map((b) => renderBlock(b, warnings)).join('');

  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(options?.subject || 'E-posta')}</title>
<style type="text/css">
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; outline:none; text-decoration:none; -ms-interpolation-mode:bicubic; }
  @media only screen and (max-width:620px) {
    .mc-container { width:100% !important; }
    .mc-hide-mobile { display:none !important; max-height:0 !important; overflow:hidden !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${bg};font-family:${font};">
${preheaderHtml}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${bg};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="mc-container" width="${width}" cellpadding="0" cellspacing="0" border="0" style="width:${width}px;max-width:100%;background-color:#ffffff;border:1px solid #e8edf2;">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;

  const variables = extractVariablesFromDocument(doc, options?.subject, preheader);
  return {
    html: sanitizeEmailHtmlFragment(html),
    plainText: htmlToPlainText(html),
    variables,
    warnings,
  };
}

export function createBlock(type: BlockType, overrides?: Partial<EmailBlock['props']>): EmailBlock {
  const id = `blk_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const defaults: Record<BlockType, Record<string, unknown>> = {
    heading: { text: 'Başlık', level: 2, align: 'left', color: '#15202b', fontSize: 22 },
    text: { text: 'Metin paragrafı…', align: 'left', color: '#334155', fontSize: 16, lineHeight: 24 },
    image: { src: '', alt: '', width: 560, align: 'center', link: '', fullWidth: false },
    logo: { src: '', alt: 'Logo', width: 160, align: 'left', link: '', logoSource: 'brand' },
    button: { text: 'Detayları gör', url: '#', align: 'center', bgColor: '#1a2332', textColor: '#ffffff', borderRadius: 6 },
    divider: { color: '#e5e7eb', height: 1 },
    spacer: { height: 24 },
    columns1: { columns: [{ blocks: [] }] },
    columns2: { columns: [{ blocks: [] }, { blocks: [] }] },
    columns3: { columns: [{ blocks: [] }, { blocks: [] }, { blocks: [] }] },
    social: { links: [{ label: 'Web', url: '' }], align: 'center' },
    company_info: { companyName: '{{marka_adi}}', address: '', email: '', website: '' },
    unsubscribe: { text: 'Bu e-postayı almak istemiyorsanız', linkText: 'abonelikten çıkın', link: '{{abonelikten_cikma_linki}}' },
    footer: { text: '© {{marka_adi}}. Tüm hakları saklıdır.' },
  };
  return { id, type, props: { ...defaults[type], ...overrides } };
}

export function createStarterDocument(brand?: {
  name?: string;
  logo_url?: string;
  accent_color?: string;
  domain?: string;
}): EditorDocument {
  const primary = brand?.accent_color || '#1a2332';
  const blocks: EmailBlock[] = [
    createBlock('logo', { src: brand?.logo_url || '', align: 'left', width: 140 }),
    createBlock('heading', { text: 'Merhaba {{tam_ad}}' }),
    createBlock('text', {
      text: '{{marka_adi}} olarak size özel bir mesajımız var. Bu alanı düzenleyerek kampanya veya bilgilendirme içeriğinizi oluşturabilirsiniz.',
    }),
    createBlock('button', { bgColor: primary, url: brand?.domain ? `https://${brand.domain}` : '#' }),
    createBlock('divider'),
    createBlock('company_info', {
      companyName: brand?.name || '{{marka_adi}}',
      website: brand?.domain ? `https://${brand.domain}` : '',
    }),
    createBlock('unsubscribe'),
    createBlock('footer'),
  ];
  return {
    version: 1,
    blocks,
    settings: {
      backgroundColor: '#f4f6f8',
      contentWidth: 600,
      primaryColor: primary,
    },
  };
}

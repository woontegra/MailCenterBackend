/** GSM-7 basic + extension characters (with ^|€{}[]~\\ needing escape → 2 septets) */
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

const GSM7_EXT = new Set(['^', '{', '}', '\\', '[', '~', ']', '|', '€']);

export type SmsSegmentInfo = {
  encoding: 'GSM-7' | 'Unicode';
  characterCount: number;
  septetCount: number;
  segmentCount: number;
  charsPerSegment: number;
  remainingInSegment: number;
};

function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch) || GSM7_EXT.has(ch)) continue;
    return false;
  }
  return true;
}

function gsm7SeptetLength(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += GSM7_EXT.has(ch) ? 2 : 1;
  }
  return n;
}

/**
 * Estimate SMS segments (industry-standard limits).
 * GSM-7: 160 single / 153 concatenated
 * UCS-2: 70 single / 67 concatenated
 */
export function analyzeSmsContent(raw: string): SmsSegmentInfo {
  const text = String(raw || '');
  const gsm = isGsm7(text);

  if (gsm) {
    const septets = gsm7SeptetLength(text);
    const single = 160;
    const multi = 153;
    const segmentCount = septets === 0 ? 0 : septets <= single ? 1 : Math.ceil(septets / multi);
    const charsPerSegment = segmentCount <= 1 ? single : multi;
    const usedInLast =
      segmentCount <= 1 ? septets : septets - (segmentCount - 1) * multi;
    return {
      encoding: 'GSM-7',
      characterCount: text.length,
      septetCount: septets,
      segmentCount,
      charsPerSegment,
      remainingInSegment: Math.max(0, charsPerSegment - usedInLast),
    };
  }

  const units = text.length; // BMP code units; surrogate pairs rare in SMS UI
  const single = 70;
  const multi = 67;
  const segmentCount = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const charsPerSegment = segmentCount <= 1 ? single : multi;
  const usedInLast = segmentCount <= 1 ? units : units - (segmentCount - 1) * multi;

  return {
    encoding: 'Unicode',
    characterCount: units,
    septetCount: units,
    segmentCount,
    charsPerSegment,
    remainingInSegment: Math.max(0, charsPerSegment - usedInLast),
  };
}

export const SMS_MAX_SEGMENTS = 6;
export const SMS_MAX_CHARS = 1000;

export function assertSmsLengthAllowed(text: string): { ok: true; info: SmsSegmentInfo } | { ok: false; error: string; info: SmsSegmentInfo } {
  const info = analyzeSmsContent(text);
  if (!text.trim()) {
    return { ok: false, error: 'Mesaj boş olamaz', info };
  }
  if (text.length > SMS_MAX_CHARS) {
    return { ok: false, error: `Mesaj en fazla ${SMS_MAX_CHARS} karakter olabilir`, info };
  }
  if (info.segmentCount > SMS_MAX_SEGMENTS) {
    return {
      ok: false,
      error: `Mesaj en fazla ${SMS_MAX_SEGMENTS} SMS parçası olabilir`,
      info,
    };
  }
  return { ok: true, info };
}

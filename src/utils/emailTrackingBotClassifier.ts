export type TrackingClassification = 'human_probable' | 'prefetch_probable' | 'bot_suspected';

const BOT_PATTERNS = [
  /proofpoint/i,
  /barracuda/i,
  /mimecast/i,
  /sophos/i,
  /symantec/i,
  /messagelabs/i,
  /fireeye/i,
  /trend micro/i,
  /curl\//i,
  /wget\//i,
  /python-requests/i,
  /go-http-client/i,
  /bot\b/i,
  /spider/i,
  /crawler/i,
];

const PREFETCH_PATTERNS = [
  /googleimageproxy/i,
  /google-image-proxy/i,
  /via ggpht\.com/i,
  /appleprivacy/i,
  /icloud-mail-proxy/i,
  /yahoo.*proxy/i,
  /outlook.*imageproxy/i,
];

export function classifyTrackingRequest(params: {
  userAgent?: string | null;
  purpose: 'open' | 'click' | 'download' | 'site';
}): { classification: TrackingClassification; deviceClass: string } {
  const ua = String(params.userAgent || '').trim();
  if (!ua) {
    return {
      classification: params.purpose === 'open' ? 'prefetch_probable' : 'bot_suspected',
      deviceClass: 'unknown',
    };
  }

  for (const pattern of BOT_PATTERNS) {
    if (pattern.test(ua)) {
      return { classification: 'bot_suspected', deviceClass: 'security_scanner' };
    }
  }

  for (const pattern of PREFETCH_PATTERNS) {
    if (pattern.test(ua)) {
      return { classification: 'prefetch_probable', deviceClass: 'privacy_proxy' };
    }
  }

  if (/mobile|android|iphone|ipad/i.test(ua)) {
    return { classification: 'human_probable', deviceClass: 'mobile' };
  }
  if (/windows|macintosh|linux/i.test(ua)) {
    return { classification: 'human_probable', deviceClass: 'desktop' };
  }

  return { classification: 'human_probable', deviceClass: 'other' };
}

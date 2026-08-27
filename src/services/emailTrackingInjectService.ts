import crypto from 'crypto';
import { query } from '../config/database';
import {
  buildClickRedirectUrl,
  buildDownloadUrl,
  buildOpenPixelUrl,
  getOrCreateTrackingKey,
} from './emailTrackingTokenService';

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    return u.toString();
  } catch {
    return url.trim();
  }
}

function urlKey(url: string): string {
  return crypto.createHash('sha256').update(normalizeUrl(url)).digest('hex').slice(0, 32);
}

function isTrackableHttpUrl(href: string): boolean {
  const h = href.trim();
  if (!/^https?:\/\//i.test(h)) return false;
  if (/^https?:\/\/.*\/unsubscribe\//i.test(h)) return false;
  if (/^https?:\/\/.*\/t\//i.test(h)) return false;
  return true;
}

function extractLinksFromHtml(html: string): Array<{ href: string; label: string }> {
  const links: Array<{ href: string; label: string }> = [];
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    const href = match[1];
    if (!isTrackableHttpUrl(href)) continue;
    const label = match[2].replace(/<[^>]+>/g, '').trim().slice(0, 255) || href.slice(0, 255);
    links.push({ href, label });
  }
  return links;
}

export async function ensureCampaignTrackingSettings(params: {
  tenantId: number;
  campaignId: number;
  trackOpens?: boolean;
  trackClicks?: boolean;
  trackSite?: boolean;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
}) {
  await query(
    `INSERT INTO campaign_tracking_settings (
       campaign_id, tenant_id, track_opens, track_clicks, track_site,
       utm_source, utm_medium, utm_campaign
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (campaign_id) DO UPDATE SET
       track_opens = COALESCE(EXCLUDED.track_opens, campaign_tracking_settings.track_opens),
       track_clicks = COALESCE(EXCLUDED.track_clicks, campaign_tracking_settings.track_clicks),
       track_site = COALESCE(EXCLUDED.track_site, campaign_tracking_settings.track_site),
       utm_source = COALESCE(EXCLUDED.utm_source, campaign_tracking_settings.utm_source),
       utm_medium = COALESCE(EXCLUDED.utm_medium, campaign_tracking_settings.utm_medium),
       utm_campaign = COALESCE(EXCLUDED.utm_campaign, campaign_tracking_settings.utm_campaign),
       updated_at = CURRENT_TIMESTAMP`,
    [
      params.campaignId,
      params.tenantId,
      params.trackOpens !== false,
      params.trackClicks !== false,
      params.trackSite === true,
      params.utmSource || null,
      params.utmMedium || 'email',
      params.utmCampaign || null,
    ]
  );
}

export async function registerCampaignLinksFromHtml(params: {
  tenantId: number;
  campaignId: number;
  html: string;
}) {
  const links = extractLinksFromHtml(params.html);
  const seen = new Set<string>();
  for (const link of links) {
    const key = urlKey(link.href);
    if (seen.has(key)) continue;
    seen.add(key);
    await query(
      `INSERT INTO campaign_tracked_links (
         tenant_id, campaign_id, link_key, label, destination_url, destination_hash
       ) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (campaign_id, link_key) DO UPDATE SET
         label = COALESCE(EXCLUDED.label, campaign_tracked_links.label)`,
      [
        params.tenantId,
        params.campaignId,
        key,
        link.label,
        normalizeUrl(link.href),
        crypto.createHash('sha256').update(normalizeUrl(link.href)).digest('hex'),
      ]
    );
  }
  return links.length;
}

export async function getTrackedLinkById(tenantId: number, linkId: number) {
  const res = await query(
    `SELECT * FROM campaign_tracked_links WHERE id = $1 AND tenant_id = $2`,
    [linkId, tenantId]
  );
  return res.rows[0] || null;
}

export async function applyEmailTrackingToHtml(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  outboundMessageId?: number | null;
  html: string;
}): Promise<string> {
  const settingsRes = await query(
    `SELECT * FROM campaign_tracking_settings WHERE campaign_id = $1 AND tenant_id = $2`,
    [params.campaignId, params.tenantId]
  );
  const settings = settingsRes.rows[0] || {
    track_opens: true,
    track_clicks: true,
    track_site: false,
  };

  let html = params.html;

  if (settings.track_clicks !== false) {
    const linksRes = await query(
      `SELECT id, destination_url, link_key FROM campaign_tracked_links
       WHERE campaign_id = $1 AND tenant_id = $2 AND is_system = false`,
      [params.campaignId, params.tenantId]
    );
    const linkMap = new Map<string, { id: number; destination_url: string }>();
    for (const row of linksRes.rows) {
      linkMap.set(String(row.link_key), row);
    }

    html = html.replace(/<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>/gi, (full, pre, href, post) => {
      if (!isTrackableHttpUrl(href)) return full;
      const key = urlKey(href);
      const tracked = linkMap.get(key);
      if (!tracked) return full;
      return `<a${pre}href="{{MC_CLICK_${tracked.id}}}"${post}>`;
    });

    for (const row of linksRes.rows) {
      const clickKey = await getOrCreateTrackingKey({
        tenantId: params.tenantId,
        campaignId: params.campaignId,
        campaignRecipientId: params.campaignRecipientId,
        outboundMessageId: params.outboundMessageId,
        purpose: 'CLICK',
        purposeRefId: Number(row.id),
      });
      html = html.replace(
        new RegExp(`\\{\\{MC_CLICK_${row.id}\\}\\}`, 'g'),
        buildClickRedirectUrl(clickKey.token)
      );
    }
  }

  if (settings.track_opens !== false && html.trim()) {
    const openKey = await getOrCreateTrackingKey({
      tenantId: params.tenantId,
      campaignId: params.campaignId,
      campaignRecipientId: params.campaignRecipientId,
      outboundMessageId: params.outboundMessageId,
      purpose: 'OPEN',
    });
    const pixel = `<img src="${buildOpenPixelUrl(openKey.token)}" alt="" width="1" height="1" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;" />`;
    if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, `${pixel}</body>`);
    } else {
      html += pixel;
    }
  }

  return html;
}

export async function buildTrackedFileLink(params: {
  tenantId: number;
  campaignId: number;
  campaignRecipientId: number;
  fileId: number;
  outboundMessageId?: number | null;
}): Promise<string> {
  const key = await getOrCreateTrackingKey({
    tenantId: params.tenantId,
    campaignId: params.campaignId,
    campaignRecipientId: params.campaignRecipientId,
    outboundMessageId: params.outboundMessageId,
    purpose: 'DOWNLOAD',
    purposeRefId: params.fileId,
  });
  return buildDownloadUrl(key.token);
}

export async function resolveClickDestination(params: {
  tenantId: number;
  linkId: number;
}): Promise<string | null> {
  const row = await getTrackedLinkById(params.tenantId, params.linkId);
  return row ? String(row.destination_url) : null;
}

export async function resolveDownloadFile(params: {
  tenantId: number;
  fileId: number;
}): Promise<{ storage_key: string; file_name: string; content_type: string | null } | null> {
  const res = await query(
    `SELECT storage_key, file_name, content_type FROM campaign_tracked_files
     WHERE id = $1 AND tenant_id = $2 AND is_active = true
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
    [params.fileId, params.tenantId]
  );
  const row = res.rows[0];
  if (!row) return null;
  const safeName = String(row.file_name || 'download').replace(/[^\w.\-() ]+/g, '_').slice(0, 200);
  return {
    storage_key: String(row.storage_key),
    file_name: safeName,
    content_type: row.content_type || null,
  };
}

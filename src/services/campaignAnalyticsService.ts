import * as XLSX from 'xlsx';
import { query } from '../config/database';
import { getCampaignForTenant } from './campaignService';
import { addContactListMembers, createContactList } from './contactListService';

const EVENT_LABELS: Record<string, string> = {
  QUEUED: 'Kuyruğa alındı',
  SEND_ATTEMPTED: 'Gönderim denendi',
  SMTP_ACCEPTED: 'Gönderim sunucusunca kabul edildi',
  DELIVERED: 'Teslim edildi',
  TEMP_DELIVERY_FAILURE: 'Geçici teslim hatası',
  PERM_DELIVERY_FAILURE: 'Kalıcı teslim hatası',
  OPEN_DETECTED: 'Açılma algılandı',
  LINK_CLICKED: 'Bağlantıya tıklandı',
  FILE_DOWNLOADED: 'Dosya indirildi',
  SITE_VISIT_VERIFIED: 'Site ziyareti doğrulandı',
  CONVERSION_COMPLETED: 'Hedef işlem tamamlandı',
  UNSUBSCRIBED: 'Abonelikten çıkıldı',
  SPAM_COMPLAINT: 'Şikâyet bildirildi',
};

function pct(num: number, den: number): number {
  if (!den) return 0;
  return Math.round((num / den) * 1000) / 10;
}

export async function getCampaignAnalyticsSummary(tenantId: number, campaignId: number) {
  const campaign = await getCampaignForTenant(tenantId, campaignId);
  if (!campaign) return null;

  const targeted = Number(campaign.recipient_count || 0);
  const engagement = await query(
    `SELECT
       COUNT(*) FILTER (WHERE queued_at IS NOT NULL)::int AS queued,
       COUNT(*) FILTER (WHERE smtp_accepted_at IS NOT NULL)::int AS smtp_accepted,
       COUNT(*) FILTER (WHERE perm_failure_at IS NOT NULL OR delivery_status = 'perm_failure')::int AS delivery_failed,
       COUNT(*) FILTER (WHERE first_open_at IS NOT NULL)::int AS opened,
       COUNT(*) FILTER (WHERE human_open_count > 0)::int AS human_opened,
       COUNT(*) FILTER (WHERE first_click_at IS NOT NULL)::int AS clicked,
       COUNT(*) FILTER (WHERE human_click_count > 0)::int AS human_clicked,
       COUNT(*) FILTER (WHERE first_download_at IS NOT NULL)::int AS downloaded,
       COUNT(*) FILTER (WHERE first_site_visit_at IS NOT NULL)::int AS site_verified,
       COUNT(*) FILTER (WHERE conversion_at IS NOT NULL)::int AS converted,
       COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS unsubscribed,
       COUNT(*) FILTER (WHERE complained_at IS NOT NULL)::int AS complained
     FROM email_recipient_engagement
     WHERE campaign_id = $1 AND tenant_id = $2`,
    [campaignId, tenantId]
  );
  const e = engagement.rows[0] || {};

  const funnel = {
    targeted,
    queued: Number(e.queued || 0),
    smtp_accepted: Number(e.smtp_accepted || campaign.sent_count || 0),
    delivery_failed: Number(e.delivery_failed || campaign.failed_count || 0),
    opened: Number(e.opened || 0),
    human_opened: Number(e.human_opened || 0),
    clicked: Number(e.clicked || 0),
    human_clicked: Number(e.human_clicked || 0),
    downloaded: Number(e.downloaded || 0),
    site_verified: Number(e.site_verified || 0),
    converted: Number(e.converted || 0),
    unsubscribed: Number(e.unsubscribed || 0),
    complained: Number(e.complained || 0),
  };

  const rates = {
    acceptance_rate: pct(funnel.smtp_accepted, funnel.targeted),
    approximate_open_rate: pct(funnel.opened, funnel.smtp_accepted),
    human_open_rate: pct(funnel.human_opened, funnel.smtp_accepted),
    unique_click_rate: pct(funnel.clicked, funnel.smtp_accepted),
    click_to_open_rate: pct(funnel.clicked, funnel.opened),
    download_rate: pct(funnel.downloaded, funnel.smtp_accepted),
    conversion_rate: pct(funnel.converted, funnel.smtp_accepted),
    unsubscribe_rate: pct(funnel.unsubscribed, funnel.smtp_accepted),
    bounce_rate: pct(funnel.delivery_failed, funnel.targeted),
  };

  return {
    campaign: {
      id: campaign.id,
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      brand_name: campaign.brand_name,
    },
    funnel,
    rates,
    disclaimers: {
      open_tracking:
        'Açılma verileri e-posta istemcilerinin gizlilik özellikleri nedeniyle yaklaşık olabilir. Düz metin e-postalarda açılma ölçülemez.',
      delivery:
        'SMTP sağlayıcımız gerçek teslim kanıtı vermediği sürece “Teslim edildi” yerine “Gönderim sunucusunca kabul edildi” gösterilir.',
      attachment:
        'Normal e-posta eki olarak eklenen dosyaların indirilip indirilmediği ölçülemez; yalnızca takip edilebilir indirme bağlantıları raporlanır.',
    },
  };
}

export async function listCampaignRecipientAnalytics(
  tenantId: number,
  campaignId: number,
  params?: {
    filter?: string;
    limit?: number;
    offset?: number;
  }
) {
  const values: unknown[] = [tenantId, campaignId];
  let where = `cr.tenant_id = $1 AND cr.campaign_id = $2`;

  const filter = String(params?.filter || '').trim();
  if (filter === 'opened') where += ` AND e.first_open_at IS NOT NULL`;
  else if (filter === 'not_opened') where += ` AND e.first_open_at IS NULL AND cr.status = 'SENT'`;
  else if (filter === 'clicked') where += ` AND e.first_click_at IS NOT NULL`;
  else if (filter === 'not_clicked') where += ` AND e.first_click_at IS NULL AND cr.status = 'SENT'`;
  else if (filter === 'downloaded') where += ` AND e.first_download_at IS NOT NULL`;
  else if (filter === 'converted') where += ` AND e.conversion_at IS NOT NULL`;
  else if (filter === 'bounced') where += ` AND (e.perm_failure_at IS NOT NULL OR cr.status = 'FAILED')`;
  else if (filter === 'unsubscribed') where += ` AND e.unsubscribed_at IS NOT NULL`;
  else if (filter === 'bot_events') {
    where += ` AND EXISTS (
      SELECT 1 FROM email_tracking_events ev
      WHERE ev.campaign_recipient_id = cr.id
        AND ev.classification IN ('bot_suspected', 'prefetch_probable')
    )`;
  } else if (filter === 'no_engagement') {
    where += ` AND cr.status = 'SENT' AND COALESCE(e.open_count,0) = 0 AND COALESCE(e.click_count,0) = 0`;
  } else if (filter === 'opened_not_clicked') {
    where += ` AND e.first_open_at IS NOT NULL AND e.first_click_at IS NULL`;
  } else if (filter === 'clicked_no_conversion') {
    where += ` AND e.first_click_at IS NOT NULL AND e.conversion_at IS NULL`;
  }

  const limit = Math.min(500, params?.limit || 50);
  const offset = params?.offset || 0;

  const res = await query(
    `SELECT cr.id, cr.contact_id, cr.email, cr.display_name, cr.status, cr.sent_at,
            e.open_count, e.human_open_count, e.click_count, e.download_count,
            e.first_open_at, e.first_click_at, e.conversion_at, e.unsubscribed_at,
            e.delivery_status, e.smtp_accepted_at
     FROM campaign_recipients cr
     LEFT JOIN email_recipient_engagement e ON e.campaign_recipient_id = cr.id
     WHERE ${where}
     ORDER BY cr.id
     LIMIT $3 OFFSET $4`,
    [...values, limit, offset]
  );
  return res.rows;
}

export async function getRecipientTimeline(tenantId: number, campaignId: number, recipientId: number) {
  const res = await query(
    `SELECT ev.event_type, ev.occurred_at, ev.classification, ev.meta,
            l.label AS link_label
     FROM email_tracking_events ev
     LEFT JOIN campaign_tracked_links l ON l.id = ev.link_id
     WHERE ev.tenant_id = $1 AND ev.campaign_id = $2 AND ev.campaign_recipient_id = $3
     ORDER BY ev.occurred_at ASC, ev.id ASC`,
    [tenantId, campaignId, recipientId]
  );

  return res.rows.map((row: any) => {
    const label = EVENT_LABELS[String(row.event_type)] || row.event_type;
    let detail = '';
    if (row.event_type === 'LINK_CLICKED' && row.link_label) {
      detail = ` — “${row.link_label}”`;
    } else if (row.meta?.event_name) {
      detail = ` — ${row.meta.event_name}`;
    }
    if (row.classification === 'prefetch_probable') {
      detail += ' (otomatik/gizlilik kaynaklı olabilir)';
    } else if (row.classification === 'bot_suspected') {
      detail += ' (şüpheli otomasyon)';
    }
    return {
      at: row.occurred_at,
      label: label + detail,
      event_type: row.event_type,
      classification: row.classification,
    };
  });
}

export async function listLinkClickReport(tenantId: number, campaignId: number) {
  const res = await query(
    `SELECT l.id, l.label, l.destination_url,
            s.total_clicks, s.unique_recipients, s.human_clicks, s.bot_clicks,
            s.first_click_at, s.last_click_at
     FROM campaign_tracked_links l
     LEFT JOIN email_link_click_stats s ON s.link_id = l.id
     WHERE l.tenant_id = $1 AND l.campaign_id = $2 AND l.is_system = false
     ORDER BY COALESCE(s.total_clicks, 0) DESC, l.id`,
    [tenantId, campaignId]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    label: r.label || 'Bağlantı',
    destination: r.destination_url,
    total_clicks: r.total_clicks || 0,
    unique_recipients: r.unique_recipients || 0,
    human_clicks: r.human_clicks || 0,
    suspicious_clicks: r.bot_clicks || 0,
    first_click_at: r.first_click_at,
    last_click_at: r.last_click_at,
  }));
}

export async function listDownloadReport(tenantId: number, campaignId: number) {
  const res = await query(
    `SELECT f.id, f.file_name,
            COUNT(ev.id)::int AS total_downloads,
            COUNT(DISTINCT ev.campaign_recipient_id)::int AS unique_recipients,
            MIN(ev.occurred_at) AS first_download_at,
            MAX(ev.occurred_at) AS last_download_at
     FROM campaign_tracked_files f
     LEFT JOIN email_tracking_events ev ON ev.file_id = f.id AND ev.event_type = 'FILE_DOWNLOADED'
     WHERE f.tenant_id = $1 AND f.campaign_id = $2 AND f.attachment_mode = 'TRACKED_LINK'
     GROUP BY f.id, f.file_name
     ORDER BY f.id`,
    [tenantId, campaignId]
  );
  return res.rows;
}

export async function saveFilteredRecipientsAsList(params: {
  tenantId: number;
  userId: number;
  campaignId: number;
  filter: string;
  listName: string;
}) {
  const rows = await listCampaignRecipientAnalytics(params.tenantId, params.campaignId, {
    filter: params.filter,
    limit: 5000,
  });
  const ids = [
    ...new Set(rows.map((r: any) => Number(r.contact_id)).filter((n: number) => n > 0)),
  ];
  if (ids.length === 0) {
    throw Object.assign(new Error('Filtreye uyan kişi bulunamadı'), { status: 400 });
  }
  const list = await createContactList({
    tenantId: params.tenantId,
    userId: params.userId,
    name: params.listName.trim(),
    description: `Kampanya #${params.campaignId} filtresi: ${params.filter}`,
  });
  await addContactListMembers({
    tenantId: params.tenantId,
    listId: list.id,
    userId: params.userId,
    contactIds: ids,
  });
  return { list_id: list.id, member_count: ids.length };
}

function sanitizeExportRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (/token|ip|payload|hash|storage_key/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export async function exportCampaignSummaryXlsx(tenantId: number, campaignId: number): Promise<Buffer> {
  const summary = await getCampaignAnalyticsSummary(tenantId, campaignId);
  if (!summary) throw Object.assign(new Error('Kampanya bulunamadı'), { status: 404 });

  const rows = [
    { Metrik: 'Hedeflenen', Değer: summary.funnel.targeted },
    { Metrik: 'Kuyruğa alınan', Değer: summary.funnel.queued },
    { Metrik: 'Sunucu kabul', Değer: summary.funnel.smtp_accepted },
    { Metrik: 'Teslim hatası', Değer: summary.funnel.delivery_failed },
    { Metrik: 'Açılma algılanan', Değer: summary.funnel.opened },
    { Metrik: 'Benzersiz tıklayan', Değer: summary.funnel.clicked },
    { Metrik: 'Dosya indiren', Değer: summary.funnel.downloaded },
    { Metrik: 'Site ziyareti doğrulanan', Değer: summary.funnel.site_verified },
    { Metrik: 'Dönüşüm', Değer: summary.funnel.converted },
    { Metrik: 'Abonelikten çıkan', Değer: summary.funnel.unsubscribed },
    { Metrik: 'Kabul oranı (%)', Değer: summary.rates.acceptance_rate },
    { Metrik: 'Yaklaşık açılma oranı (%)', Değer: summary.rates.approximate_open_rate },
    { Metrik: 'Benzersiz tıklama oranı (%)', Değer: summary.rates.unique_click_rate },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Özet');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function exportRecipientsXlsx(
  tenantId: number,
  campaignId: number,
  filter?: string
): Promise<Buffer> {
  const rows = await listCampaignRecipientAnalytics(tenantId, campaignId, { filter, limit: 5000 });
  const data = rows.map((r: any) =>
    sanitizeExportRow({
      email: r.email,
      ad: r.display_name,
      durum: r.status,
      gonderim: r.sent_at,
      acilma_sayisi: r.open_count || 0,
      insan_acilma: r.human_open_count || 0,
      tiklama_sayisi: r.click_count || 0,
      indirme_sayisi: r.download_count || 0,
      ilk_acilma: r.first_open_at,
      ilk_tiklama: r.first_click_at,
      donusum: r.conversion_at,
      abonelikten_cikma: r.unsubscribed_at,
    })
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Alıcılar');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function exportLinksXlsx(tenantId: number, campaignId: number): Promise<Buffer> {
  const rows = await listLinkClickReport(tenantId, campaignId);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      rows.map((r) =>
        sanitizeExportRow({
          etiket: r.label,
          hedef: r.destination,
          toplam_tiklama: r.total_clicks,
          benzersiz_kisi: r.unique_recipients,
          insan_tiklama: r.human_clicks,
          supheli_tiklama: r.suspicious_clicks,
        })
      )
    ),
    'Bağlantılar'
  );
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export function buildSiteTrackingSnippet(trackingBaseUrl: string): string {
  return `(function(){
  var s=document.currentScript;
  var t=(new URLSearchParams(location.search)).get('mc_at');
  if(!t)return;
  function send(name,dedupe){
    try{
      fetch('${trackingBaseUrl.replace(/'/g, "\\'")}/t/site',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token:t,event:name,dedupe_id:dedupe||name}),
        keepalive:true
      });
    }catch(e){}
  }
  send('page_viewed','pv:'+location.pathname);
  window.mcTrack=function(name,dedupe){send(name,dedupe||name);};
})();`;
}

/**
 * Global WhatsApp ready-template catalog (V1).
 * Same definitions for every tenant; installs are per-WABA in `templates`.
 */

export type WhatsAppReadyTemplateVariable = {
  index: number;
  key: string;
  label: string;
  example: string;
};

export type WhatsAppReadyTemplateCatalogItem = {
  key: string;
  displayName: string;
  description: string;
  providerName: string;
  category: 'UTILITY' | 'MARKETING';
  language: string;
  bodyText: string;
  variables: WhatsAppReadyTemplateVariable[];
};

export const WHATSAPP_READY_TEMPLATE_CATALOG: WhatsAppReadyTemplateCatalogItem[] = [
  {
    key: 'payment_due_reminder',
    displayName: 'Son ödeme tarihi hatırlatması',
    description: 'Müşteriye yaklaşan ödeme tarihini ve tutarı hatırlatır.',
    providerName: 'mc_odeme_son_tarih',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} tutarındaki ödemenizin son ödeme tarihi {{3}}’tür. Ödeme bilgisi: {{4}} Lütfen zamanında ödeme yapınız.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Ayşe Yılmaz' },
      { index: 2, key: 'amount', label: 'Tutar', example: '1.250 TL' },
      { index: 3, key: 'due_date', label: 'Son ödeme tarihi', example: '15.04.2026' },
      { index: 4, key: 'payment_info', label: 'Ödeme bilgisi / link', example: 'https://odeme.ornek.com/fatura/123' },
    ],
  },
  {
    key: 'payment_overdue',
    displayName: 'Vadesi geçmiş ödeme bildirimi',
    description: 'Geciken ödemeyi nazikçe bildirir ve ödeme yolunu hatırlatır.',
    providerName: 'mc_odeme_vadesi_gecmis',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} tutarındaki ödemenizin vadesi {{3}} tarihinde geçmiştir. Lütfen en kısa sürede ödeme yapın: {{4}} Bilginize sunarız.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Mehmet Demir' },
      { index: 2, key: 'amount', label: 'Tutar', example: '890 TL' },
      { index: 3, key: 'due_date', label: 'Vade tarihi', example: '01.04.2026' },
      { index: 4, key: 'payment_info', label: 'Ödeme bilgisi / link', example: 'https://odeme.ornek.com/geciken/45' },
    ],
  },
  {
    key: 'payment_received',
    displayName: 'Ödeme alındı / teşekkür',
    description: 'Ödemenin alındığını onaylar ve teşekkür eder.',
    providerName: 'mc_odeme_alindi',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} tutarındaki ödemeniz {{3}} tarihinde alınmıştır. Teşekkür ederiz. Referans: {{4}} İyi günler dileriz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Zeynep Kaya' },
      { index: 2, key: 'amount', label: 'Tutar', example: '2.000 TL' },
      { index: 3, key: 'paid_at', label: 'Ödeme tarihi', example: '10.04.2026' },
      { index: 4, key: 'reference', label: 'Referans / makbuz no', example: 'ODM-78421' },
    ],
  },
  {
    key: 'appointment_reminder',
    displayName: 'Randevu hatırlatması',
    description: 'Yaklaşan randevunun tarih, saat ve yer bilgisini hatırlatır.',
    providerName: 'mc_randevu_hatirlatma',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} tarihindeki randevunuzu hatırlatmak isteriz. Saat: {{3}}. Konum / not: {{4}} Görüşmek üzere.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Elif Şahin' },
      { index: 2, key: 'appointment_date', label: 'Randevu tarihi', example: '18.04.2026' },
      { index: 3, key: 'appointment_time', label: 'Saat', example: '14:30' },
      { index: 4, key: 'location_note', label: 'Konum / not', example: 'Kadıköy şube, 2. kat' },
    ],
  },
  {
    key: 'appointment_reschedule',
    displayName: 'Randevu değişikliği',
    description: 'Randevunun yeni tarih ve saatini bildirir.',
    providerName: 'mc_randevu_degisiklik',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, randevunuz güncellendi. Yeni tarih: {{2}}, saat: {{3}}. Detay: {{4}} Anlayışınız için teşekkür ederiz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Can Öztürk' },
      { index: 2, key: 'new_date', label: 'Yeni tarih', example: '20.04.2026' },
      { index: 3, key: 'new_time', label: 'Yeni saat', example: '11:00' },
      { index: 4, key: 'detail', label: 'Detay / neden', example: 'Uzman müsaitlik güncellemesi' },
    ],
  },
  {
    key: 'appointment_cancel',
    displayName: 'Randevu iptali',
    description: 'Randevunun iptal edildiğini bildirir.',
    providerName: 'mc_randevu_iptal',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} tarihli randevunuz iptal edilmiştir. Yeni randevu için: {{3}} İyi günler dileriz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Deniz Acar' },
      { index: 2, key: 'appointment_date', label: 'Randevu tarihi', example: '12.04.2026' },
      { index: 3, key: 'rebook_info', label: 'Yeniden randevu bilgisi', example: 'https://randevu.ornek.com' },
    ],
  },
  {
    key: 'order_received',
    displayName: 'Sipariş alındı',
    description: 'Siparişin alındığını ve sipariş numarasını bildirir.',
    providerName: 'mc_siparis_alindi',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} numaralı siparişiniz alınmıştır. Toplam: {{3}}. Takip: {{4}} Siparişiniz için teşekkür ederiz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Burak Çelik' },
      { index: 2, key: 'order_id', label: 'Sipariş no', example: 'SIP-99012' },
      { index: 3, key: 'total', label: 'Toplam tutar', example: '3.450 TL' },
      { index: 4, key: 'track_info', label: 'Takip bilgisi / link', example: 'https://siparis.ornek.com/SIP-99012' },
    ],
  },
  {
    key: 'order_preparing',
    displayName: 'Sipariş hazırlanıyor',
    description: 'Siparişin hazırlandığını bildirir.',
    providerName: 'mc_siparis_hazirlaniyor',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} numaralı siparişiniz hazırlanıyor. Tahmini süre: {{3}}. Detay: {{4}} Hazır olduğunda bilgilendirileceksiniz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Selin Arslan' },
      { index: 2, key: 'order_id', label: 'Sipariş no', example: 'SIP-99012' },
      { index: 3, key: 'eta', label: 'Tahmini süre', example: '1–2 iş günü' },
      { index: 4, key: 'detail', label: 'Detay / link', example: 'https://siparis.ornek.com/SIP-99012' },
    ],
  },
  {
    key: 'order_shipped',
    displayName: 'Sipariş kargoya verildi',
    description: 'Kargo firması ve takip bilgisini paylaşır.',
    providerName: 'mc_siparis_kargoda',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} numaralı siparişiniz kargoya verildi. Kargo: {{3}}. Takip no: {{4}} Kargonuzu takip edebilirsiniz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Hakan Yıldız' },
      { index: 2, key: 'order_id', label: 'Sipariş no', example: 'SIP-99012' },
      { index: 3, key: 'carrier', label: 'Kargo firması', example: 'Yurtiçi Kargo' },
      { index: 4, key: 'tracking_no', label: 'Takip numarası', example: 'YK123456789TR' },
    ],
  },
  {
    key: 'document_reminder',
    displayName: 'Evrak / belge hatırlatması',
    description: 'Eksik belge veya evrak teslimini hatırlatır.',
    providerName: 'mc_evrak_hatirlatma',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} işlemi için {{3}} belgesine ihtiyacımız var. Son tarih: {{4}} Belgelerinizi zamanında iletmenizi rica ederiz.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'İrem Koç' },
      { index: 2, key: 'process_name', label: 'İşlem adı', example: 'Başvuru dosyası' },
      { index: 3, key: 'document_name', label: 'Belge adı', example: 'Kimlik fotokopisi' },
      { index: 4, key: 'deadline', label: 'Son tarih', example: '22.04.2026' },
    ],
  },
  {
    key: 'general_info',
    displayName: 'Genel bilgilendirme',
    description: 'Operasyonel bilgilendirme mesajı (yardımcı içerik).',
    providerName: 'mc_genel_bilgilendirme',
    category: 'UTILITY',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, bilgilendirme: {{2}}. Detay: {{3}} Bilginize sunarız.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Nazan Güneş' },
      { index: 2, key: 'info_text', label: 'Bilgi metni', example: 'Şubeniz yarın 12:00’de açılacaktır' },
      { index: 3, key: 'detail', label: 'Detay / link', example: 'https://bilgi.ornek.com' },
    ],
  },
  {
    key: 'campaign_announcement',
    displayName: 'Kampanya / duyuru',
    description: 'Pazarlama kampanyası veya duyuru mesajı.',
    providerName: 'mc_kampanya_duyuru',
    category: 'MARKETING',
    language: 'tr',
    bodyText:
      'Merhaba {{1}}, {{2}} kampanyamız başladı! Avantaj: {{3}}. Detaylar: {{4}} Fırsatı kaçırmayın.',
    variables: [
      { index: 1, key: 'customer_name', label: 'Müşteri adı', example: 'Emre Aydın' },
      { index: 2, key: 'campaign_name', label: 'Kampanya adı', example: 'Bahar fırsatı' },
      { index: 3, key: 'benefit', label: 'Avantaj / teklif', example: '%20 indirim' },
      { index: 4, key: 'detail_link', label: 'Detay linki', example: 'https://kampanya.ornek.com/bahar' },
    ],
  },
];

export function getReadyTemplateByKey(key: string): WhatsAppReadyTemplateCatalogItem | null {
  const k = String(key || '').trim();
  return WHATSAPP_READY_TEMPLATE_CATALOG.find((item) => item.key === k) || null;
}

export function getReadyTemplateByProviderName(
  providerName: string
): WhatsAppReadyTemplateCatalogItem | null {
  const n = String(providerName || '').trim();
  return WHATSAPP_READY_TEMPLATE_CATALOG.find((item) => item.providerName === n) || null;
}

/** Count unique {{1}}…{{n}} placeholders (max index). */
export function countBodyPlaceholders(bodyText: string): number {
  const matches = String(bodyText || '').matchAll(/\{\{(\d+)\}\}/g);
  let max = 0;
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

/** Ordered unique placeholder indices as they first appear in body text. */
export function listBodyPlaceholderOrder(bodyText: string): number[] {
  const seen = new Set<number>();
  const order: number[] = [];
  for (const m of String(bodyText || '').matchAll(/\{\{(\d+)\}\}/g)) {
    const n = Number(m[1]);
    if (!Number.isFinite(n) || seen.has(n)) continue;
    seen.add(n);
    order.push(n);
  }
  return order;
}

/** Meta forbids BODY text that starts or ends with a parameter. */
export function bodyStartsWithPlaceholder(bodyText: string): boolean {
  return /^\s*\{\{\d+\}\}/.test(String(bodyText || ''));
}

export function bodyEndsWithPlaceholder(bodyText: string): boolean {
  return /\{\{\d+\}\}\s*$/.test(String(bodyText || ''));
}

/**
 * True when the last placeholder is followed by at least one letter/digit
 * (not merely punctuation/spaces).
 */
export function bodyHasStaticTextAfterLastPlaceholder(bodyText: string): boolean {
  const text = String(bodyText || '');
  const matches = [...text.matchAll(/\{\{\d+\}\}/g)];
  if (matches.length === 0) return true;
  const last = matches[matches.length - 1];
  const after = text.slice((last.index ?? 0) + last[0].length);
  return /[A-Za-zÀ-ÖØ-öø-ÿĀ-žА-яЁёĞğİıŞşÇçÜüÖö0-9]/.test(after);
}

/** Replace {{1}}…{{n}} with example values for UI preview. */
export function buildCatalogPreview(bodyText: string, examples: string[]): string {
  let out = String(bodyText || '');
  examples.forEach((ex, i) => {
    out = out.replace(new RegExp(`\\{\\{${i + 1}\\}\\}`, 'g'), String(ex ?? ''));
  });
  return out;
}

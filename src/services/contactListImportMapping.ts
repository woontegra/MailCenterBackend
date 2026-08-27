export type ListImportMapping = {
  organization_name?: string;
  contact_name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  city?: string;
  notes?: string;
  email_permission?: string;
  whatsapp_permission?: string;
};

export const CONTACT_LIST_SAMPLE_COLUMNS = [
  'Kurum / Kişi Adı',
  'Yetkili Adı',
  'E-posta',
  'Telefon',
  'Şehir',
  'Not',
  'E-posta İzni',
  'WhatsApp İzni',
] as const;

const ORG_ALIASES = [
  'kurum / kisi adi',
  'kurum / kisi adı',
  'kurum adi',
  'kurum adı',
  'baro adi',
  'baro adı',
  'firma adi',
  'firma adı',
  'sirket adi',
  'şirket adı',
  'kisi adi',
  'kişi adı',
  'ad soyad',
  'ad soyad / kurum adi',
  'ad soyad / kurum adı',
  'isim',
  'unvan',
  'kurum',
  'firma',
  'baro',
];

const CONTACT_NAME_ALIASES = [
  'yetkili adi',
  'yetkili adı',
  'yetkili',
  'contact name',
  'contact',
];

const EMAIL_ALIASES = ['e-posta', 'eposta', 'e posta', 'email', 'e-mail', 'mail'];
const PHONE_ALIASES = ['telefon', 'cep telefonu', 'gsm', 'mobile', 'phone', 'tel'];
const CITY_ALIASES = ['sehir', 'şehir', 'il', 'city'];
const NOTES_ALIASES = ['not', 'aciklama', 'açıklama', 'notes', 'note'];
const EMAIL_PERM_ALIASES = ['e-posta izni', 'eposta izni', 'email izni', 'email permission'];
const WHATSAPP_PERM_ALIASES = ['whatsapp izni', 'whatsapp permission', 'wa izni'];

function normalizeHeaderKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ');
}

function findHeader(headers: string[], aliases: string[]): string | undefined {
  const byNorm = new Map(headers.map((h) => [normalizeHeaderKey(h), h]));
  for (const alias of aliases) {
    const hit = byNorm.get(alias);
    if (hit) return hit;
  }
  return undefined;
}

export function detectImportMapping(headers: string[]): ListImportMapping {
  const org =
    findHeader(headers, ORG_ALIASES) ||
    headers.find((h) => {
      const norm = normalizeHeaderKey(h);
      return ['baro', 'kurum', 'firma', 'sirket', 'unvan', 'ad soyad'].some((token) =>
        norm.includes(token)
      );
    });

  return {
    organization_name: org,
    contact_name: findHeader(headers, CONTACT_NAME_ALIASES),
    email: findHeader(headers, EMAIL_ALIASES),
    phone: findHeader(headers, PHONE_ALIASES),
    city: findHeader(headers, CITY_ALIASES),
    notes: findHeader(headers, NOTES_ALIASES),
    email_permission: findHeader(headers, EMAIL_PERM_ALIASES),
    whatsapp_permission: findHeader(headers, WHATSAPP_PERM_ALIASES),
  };
}

export function mergeImportMapping(
  userMapping: ListImportMapping | undefined,
  detected: ListImportMapping
): ListImportMapping {
  const merged: ListImportMapping = { ...detected };
  if (!userMapping) return merged;
  for (const [key, value] of Object.entries(userMapping)) {
    const trimmed = String(value || '').trim();
    if (trimmed) (merged as any)[key] = trimmed;
  }
  return merged;
}

export function formatContactListMemberLabel(row: {
  company_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string {
  const company = String(row.company_name || '').trim();
  const person = [row.first_name, row.last_name]
    .map((v) => String(v || '').trim())
    .filter(Boolean)
    .join(' ');
  if (company) return company;
  if (person) return person;
  return 'Ad bilgisi yok';
}

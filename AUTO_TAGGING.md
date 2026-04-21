# MailCenter Otomatik Etiketleme Sistemi

Gelen mailleri anahtar kelimelere göre otomatik etiketleyen akıllı sistem.

## 🎯 Nasıl Çalışır?

### 1. Mail Çekildiğinde
```
IMAP → Mail çekilir → Veritabanına kaydedilir → Otomatik etiketleme çalışır
```

### 2. Etiketleme Süreci
1. **Subject + Body Preview** kontrol edilir
2. Anahtar kelimeler aranır (case-insensitive)
3. Eşleşen etiketler bulunur
4. Etiketler otomatik olarak mail'e eklenir

### 3. Performans
- ✅ Basit `includes()` kontrolü
- ✅ Lowercase karşılaştırma
- ✅ Asenkron işlem (mail kaydetmeyi bloklamaz)
- ✅ Hata durumunda sessizce devam eder

## 📋 Varsayılan Keyword'ler

### Fatura Etiketi
```javascript
['fatura', 'invoice', 'ödeme', 'payment', 'tahsilat', 'dekont']
```

**Örnek eşleşmeler:**
- "Fatura Gönderimi" → ✅ etiketlenir
- "Invoice #12345" → ✅ etiketlenir
- "Ödeme yapıldı" → ✅ etiketlenir

### Teklif Etiketi
```javascript
['teklif', 'proposal', 'quotation', 'quote', 'öneri', 'offer']
```

**Örnek eşleşmeler:**
- "Yeni Teklif" → ✅ etiketlenir
- "Price Quotation" → ✅ etiketlenir
- "Offer for Project" → ✅ etiketlenir

### Müşteri Etiketi
```javascript
['müşteri', 'customer', 'client', 'destek', 'support', 'talep']
```

**Örnek eşleşmeler:**
- "Müşteri Talebi" → ✅ etiketlenir
- "Customer Support" → ✅ etiketlenir
- "Destek Talebi" → ✅ etiketlenir

## 🚀 Kullanım

### Otomatik Etiketleme
Mail çekildiğinde **otomatik** çalışır. Ekstra bir işlem gerekmez.

### Keyword'leri Görüntüleme
```bash
GET /api/auto-tag/keywords
Authorization: Bearer <token>
```

**Response:**
```json
[
  {
    "tagName": "fatura",
    "keywords": ["fatura", "invoice", "ödeme", "payment", "tahsilat", "dekont"]
  },
  {
    "tagName": "teklif",
    "keywords": ["teklif", "proposal", "quotation", "quote", "öneri", "offer"]
  },
  {
    "tagName": "müşteri",
    "keywords": ["müşteri", "customer", "client", "destek", "support", "talep"]
  }
]
```

### Yeni Keyword Ekleme
```bash
POST /api/auto-tag/keywords
Authorization: Bearer <token>
Content-Type: application/json

{
  "tagName": "fatura",
  "keywords": ["makbuz", "receipt"]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Added 2 keywords to fatura"
}
```

### Yeni Etiket İçin Keyword Tanımlama
```bash
POST /api/auto-tag/keywords
Authorization: Bearer <token>
Content-Type: application/json

{
  "tagName": "acil",
  "keywords": ["urgent", "acil", "asap", "hemen", "kritik"]
}
```

## 💡 Örnekler

### Örnek 1: Fatura Maili
**Mail:**
```
Subject: Fatura #2024-001
Body: Sayın müşterimiz, ekteki faturayı inceleyebilirsiniz.
```

**Sonuç:**
- ✅ `fatura` etiketi otomatik eklenir
- ✅ `müşteri` etiketi otomatik eklenir

### Örnek 2: Teklif Maili
**Mail:**
```
Subject: Yeni Proje Teklifi
Body: Projeniz için hazırladığımız teklifi ekte bulabilirsiniz.
```

**Sonuç:**
- ✅ `teklif` etiketi otomatik eklenir

### Örnek 3: Destek Talebi
**Mail:**
```
Subject: Customer Support Request
Body: We need urgent support for our system.
```

**Sonuç:**
- ✅ `müşteri` etiketi otomatik eklenir (support kelimesi)

## 🔧 Teknik Detaylar

### AutoTagService
**Dosya:** `src/services/autoTagService.ts`

**Ana Metodlar:**
- `autoTagMail()` - Mail'i otomatik etiketle
- `findMatchingTags()` - Eşleşen etiketleri bul
- `addCustomKeywords()` - Yeni keyword ekle
- `getKeywords()` - Tüm keyword'leri getir

### Entegrasyon
**MailFetchService** içinde otomatik çalışır:

```typescript
// Mail kaydedilir
const result = await query(`INSERT INTO mails ...`);

// Otomatik etiketleme
if (result.rows.length > 0) {
  await autoTagService.autoTagMail(
    mailId,
    subject,
    bodyPreview,
    tenantId
  );
}
```

### Performans Özellikleri
- ✅ **Asenkron:** Mail kaydetmeyi bloklamaz
- ✅ **Hata toleranslı:** Etiketleme hatası mail kaydını etkilemez
- ✅ **Verimli:** Basit string matching (regex değil)
- ✅ **Ölçeklenebilir:** Keyword sayısı artırılabilir

## 🎨 Genişletme

### 1. Regex Desteği Eklemek
```typescript
// autoTagService.ts içinde
private findMatchingTags(content: string): string[] {
  const matched: string[] = [];

  for (const tagKeyword of this.tagKeywords) {
    // Regex pattern desteği
    const hasMatch = tagKeyword.keywords.some((keyword) => {
      if (keyword.startsWith('/') && keyword.endsWith('/')) {
        const pattern = new RegExp(keyword.slice(1, -1), 'i');
        return pattern.test(content);
      }
      return content.includes(keyword.toLowerCase());
    });

    if (hasMatch && !matched.includes(tagKeyword.tagName)) {
      matched.push(tagKeyword.tagName);
    }
  }

  return matched;
}
```

### 2. Veritabanında Keyword Saklama
```sql
CREATE TABLE auto_tag_keywords (
  id SERIAL PRIMARY KEY,
  tag_id INTEGER REFERENCES tags(id),
  keyword VARCHAR(255),
  tenant_id INTEGER REFERENCES tenants(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### 3. AI Tabanlı Etiketleme
```typescript
// OpenAI API ile akıllı etiketleme
async aiAutoTag(subject: string, body: string) {
  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{
      role: "system",
      content: "Classify this email into tags: fatura, teklif, müşteri"
    }, {
      role: "user",
      content: `Subject: ${subject}\nBody: ${body}`
    }]
  });
  
  return response.choices[0].message.content;
}
```

### 4. Öncelik Bazlı Etiketleme
```typescript
interface TagKeyword {
  tagName: string;
  keywords: string[];
  priority: number; // 1-10
}

// Yüksek öncelikli etiketler önce kontrol edilir
this.tagKeywords.sort((a, b) => b.priority - a.priority);
```

## 📊 İstatistikler

### Etiketleme Başarı Oranı
```sql
-- Otomatik etiketlenen mail sayısı
SELECT COUNT(DISTINCT mail_id) 
FROM mail_tags 
WHERE created_at > NOW() - INTERVAL '7 days';

-- Toplam mail sayısı
SELECT COUNT(*) 
FROM mails 
WHERE created_at > NOW() - INTERVAL '7 days';
```

### En Çok Kullanılan Etiketler
```sql
SELECT t.name, COUNT(*) as count
FROM mail_tags mt
JOIN tags t ON mt.tag_id = t.id
WHERE mt.created_at > NOW() - INTERVAL '30 days'
GROUP BY t.name
ORDER BY count DESC;
```

## ⚙️ Yapılandırma

### Keyword Listesini Özelleştirme
```typescript
// server.ts veya config dosyasında
const autoTagService = new AutoTagService();

// Özel keyword'ler ekle
autoTagService.addCustomKeywords('finans', [
  'bütçe', 'budget', 'maliyet', 'cost'
]);

autoTagService.addCustomKeywords('toplantı', [
  'meeting', 'toplantı', 'görüşme', 'appointment'
]);
```

### Environment Variables
```env
# .env dosyasında
AUTO_TAG_ENABLED=true
AUTO_TAG_MIN_CONFIDENCE=0.7
AUTO_TAG_MAX_TAGS_PER_MAIL=5
```

## 🐛 Hata Ayıklama

### Log Kontrolü
```bash
# Otomatik etiketleme logları
✓ Auto-tagged mail 123 with 2 tags
```

### Manuel Test
```bash
# Test maili gönder
curl -X POST http://localhost:5000/api/send-mail \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": 1,
    "to": "test@example.com",
    "subject": "Test Fatura",
    "text": "Bu bir test faturasıdır"
  }'

# Mail'in etiketlerini kontrol et
curl http://localhost:5000/api/mails \
  -H "Authorization: Bearer <token>"
```

## 🔐 Güvenlik

### Tenant İzolasyonu
- ✅ Her tenant kendi keyword'lerini yönetir
- ✅ Etiketler tenant_id ile filtrelenir
- ✅ Cross-tenant etiketleme mümkün değil

### Rate Limiting
```typescript
// Çok fazla keyword eklemeyi engelle
if (keywords.length > 100) {
  throw new Error('Maximum 100 keywords per request');
}
```

## 📝 Notlar

### Avantajlar
- ✅ Basit ve hızlı
- ✅ Genişletilebilir
- ✅ Performanslı
- ✅ Tenant-aware
- ✅ Hata toleranslı

### Sınırlamalar
- ⚠️ Sadece exact match (regex yok)
- ⚠️ Keyword'ler bellekte (veritabanında değil)
- ⚠️ Türkçe karakter duyarlılığı yok (şimdilik)

### Gelecek İyileştirmeler
- [ ] Regex pattern desteği
- [ ] Veritabanında keyword saklama
- [ ] AI tabanlı etiketleme
- [ ] Öncelik bazlı etiketleme
- [ ] Etiketleme istatistikleri
- [ ] Manuel etiket önerileri

## 🎉 Sonuç

Otomatik etiketleme sistemi:
- ✅ Mail çekildiğinde otomatik çalışır
- ✅ Subject + body'de keyword arar
- ✅ Eşleşen etiketleri otomatik ekler
- ✅ Performanslı ve genişletilebilir
- ✅ Tenant izolasyonu sağlar

**Artık mailler otomatik olarak organize ediliyor!** 🚀

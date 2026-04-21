# SMTP Mail Gönderme Özelliği

MailCenter'a SMTP ile mail gönderme özelliği eklendi.

## Yeni Özellikler

### 1. Database Değişiklikleri

**mail_accounts tablosuna eklenen alanlar:**
- `smtp_host` - SMTP sunucu adresi (örn: smtp.gmail.com)
- `smtp_port` - SMTP port (varsayılan: 587)
- `smtp_user` - SMTP kullanıcı adı
- `smtp_password` - SMTP şifresi
- `smtp_secure` - SSL/TLS kullanımı (varsayılan: false)

**mails tablosuna eklenen alan:**
- `is_sent` - Mailin gönderilmiş olup olmadığı (varsayılan: false)

### 2. Migration

Mevcut veritabanını güncellemek için:

```bash
psql -d mailcenter -f src/database/migrations/add-smtp-fields.sql
```

Veya yeni kurulum için:

```bash
npm run db:migrate
```

### 3. API Endpoints

#### Mail Gönder
```
POST /api/send-mail
```

**Request Body:**
```json
{
  "accountId": 1,
  "to": "alici@example.com",
  "subject": "Konu başlığı",
  "text": "Düz metin içerik",
  "html": "<p>HTML içerik</p>"
}
```

**Response (Başarılı):**
```json
{
  "success": true,
  "messageId": "<unique-message-id>"
}
```

**Response (Hata):**
```json
{
  "success": false,
  "error": "Hata mesajı"
}
```

#### Hesap Oluştur (SMTP ile)
```
POST /api/accounts
```

**Request Body:**
```json
{
  "name": "İş Maili",
  "email": "is@example.com",
  "imap_host": "imap.gmail.com",
  "imap_port": 993,
  "imap_user": "is@example.com",
  "imap_password": "imap_sifre",
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 587,
  "smtp_user": "is@example.com",
  "smtp_password": "smtp_sifre",
  "smtp_secure": false
}
```

#### Hesap SMTP Ayarlarını Güncelle
```
PATCH /api/accounts/:id
```

**Request Body:**
```json
{
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 587,
  "smtp_user": "user@example.com",
  "smtp_password": "sifre",
  "smtp_secure": false
}
```

### 4. Kullanım Örneği

```bash
# Mail gönder
curl -X POST http://localhost:5000/api/send-mail \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": 1,
    "to": "test@example.com",
    "subject": "Test Mail",
    "text": "Bu bir test mailidir",
    "html": "<h1>Test Mail</h1><p>Bu bir test mailidir</p>"
  }'
```

### 5. Özellikler

✅ **Nodemailer entegrasyonu** - Güvenilir mail gönderimi  
✅ **Hesap bazlı gönderim** - Her hesap kendi SMTP ayarlarını kullanır  
✅ **Otomatik kayıt** - Gönderilen mailler `mails` tablosuna kaydedilir  
✅ **Hata yönetimi** - Detaylı hata mesajları  
✅ **HTML/Text desteği** - Hem düz metin hem HTML mail gönderimi  
✅ **SMTP doğrulama** - Bağlantı testi yapılabilir  

### 6. Gmail Kullanımı

Gmail ile kullanmak için:

1. Google hesabınızda "2 Adımlı Doğrulama" açın
2. "Uygulama Şifreleri" bölümünden yeni şifre oluşturun
3. Bu şifreyi `smtp_password` olarak kullanın

**Gmail Ayarları:**
- `smtp_host`: smtp.gmail.com
- `smtp_port`: 587
- `smtp_secure`: false

### 7. Gönderilen Mailleri Görüntüleme

Gönderilen mailleri listelemek için:

```bash
GET /api/mails?is_sent=true
```

### 8. Güvenlik Notları

⚠️ SMTP şifreleri veritabanında saklanır  
⚠️ Üretim ortamında şifreleri encrypt edin  
⚠️ HTTPS kullanın  
⚠️ Rate limiting ekleyin  

## Kurulum

```bash
# Bağımlılıkları yükle
npm install

# Migration çalıştır
npm run db:migrate

# Sunucuyu başlat
npm run dev
```

## Test

```bash
# Hesap ekle
curl -X POST http://localhost:5000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@gmail.com",
    "imap_host": "imap.gmail.com",
    "imap_user": "test@gmail.com",
    "imap_password": "imap_pass",
    "smtp_host": "smtp.gmail.com",
    "smtp_user": "test@gmail.com",
    "smtp_password": "smtp_pass"
  }'

# Mail gönder
curl -X POST http://localhost:5000/api/send-mail \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": 1,
    "to": "receiver@example.com",
    "subject": "Test",
    "text": "Hello World"
  }'
```

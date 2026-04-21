# MailCenter Multi-Tenant SaaS Setup

MailCenter artık **multi-tenant SaaS** yapısına sahip. Her kullanıcı sadece kendi verilerini görebilir.

## 🎯 Yapılan Değişiklikler

### 1. Database Şeması

#### Yeni Tablolar
- **tenants** - Kiracı organizasyonları
- **users** - Kullanıcılar (her kullanıcı bir tenant'a bağlı)

#### Mevcut Tablolara Eklenen Alan
Tüm tablolara `tenant_id` eklendi:
- `mail_accounts`
- `mails`
- `tags`
- `mail_tags`

### 2. Authentication Sistemi

**JWT tabanlı kimlik doğrulama:**
- Kullanıcı kaydı (register)
- Giriş (login)
- Token doğrulama

**Bağımlılıklar:**
- `jsonwebtoken` - JWT token yönetimi
- `bcrypt` - Şifre hashleme

### 3. Tenant Isolation

**Her API isteği tenant_id ile filtrelenir:**
```sql
SELECT * FROM mails WHERE tenant_id = $1
```

**Middleware:**
- `authenticate` - Her istekte JWT token doğrular
- `req.user.tenantId` - İstek yapan kullanıcının tenant ID'si

### 4. Güvenlik

✅ **Şifre güvenliği** - bcrypt ile hash  
✅ **JWT token** - 7 gün geçerlilik  
✅ **Tenant izolasyonu** - Kullanıcılar sadece kendi verilerini görebilir  
✅ **SQL injection koruması** - Parametreli sorgular  

## 🚀 Kurulum

### 1. Migration Çalıştır

Mevcut veritabanını güncellemek için:

```bash
cd backend
psql -d mailcenter -f src/database/migrations/add-multi-tenant.sql
```

Yeni kurulum için:

```bash
npm run db:migrate
```

### 2. Environment Variables

`.env` dosyasına ekle:

```env
JWT_SECRET=your_super_secret_jwt_key_change_this_in_production
JWT_EXPIRES_IN=7d
```

### 3. Bağımlılıkları Yükle

```bash
npm install
```

### 4. Sunucuyu Başlat

```bash
npm run dev
```

## 📡 API Endpoints

### Authentication

#### Kayıt Ol
```
POST /api/auth/register
```

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepassword",
  "tenantName": "My Company"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "tenant_id": 1
  }
}
```

#### Giriş Yap
```
POST /api/auth/login
```

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepassword"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "tenant_id": 1
  }
}
```

#### Kullanıcı Bilgisi
```
GET /api/auth/me
Authorization: Bearer <token>
```

### Korumalı Endpoints

**Tüm diğer endpoint'ler artık authentication gerektirir:**

```bash
# Header ekle
Authorization: Bearer <your_jwt_token>
```

**Örnekler:**

```bash
# Mail hesabı ekle
curl -X POST http://localhost:5000/api/accounts \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "work@gmail.com",
    "imap_host": "imap.gmail.com",
    "imap_user": "work@gmail.com",
    "imap_password": "password"
  }'

# Mailleri listele
curl http://localhost:5000/api/mails \
  -H "Authorization: Bearer <token>"

# Mail gönder
curl -X POST http://localhost:5000/api/send-mail \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": 1,
    "to": "recipient@example.com",
    "subject": "Test",
    "text": "Hello"
  }'
```

## 🔐 Tenant Isolation Nasıl Çalışır?

### 1. Kullanıcı Kaydı
```
User registers → Tenant created → User linked to tenant → Default tags created
```

### 2. Her İstek
```
Request → JWT token verified → tenantId extracted → Query filtered by tenantId
```

### 3. Veri Erişimi
```sql
-- ❌ ESKİ (Tüm veriler)
SELECT * FROM mails

-- ✅ YENİ (Sadece kullanıcının tenant'ına ait)
SELECT * FROM mails WHERE tenant_id = $1
```

## 📊 Database İlişkileri

```
tenants (1) ──┬── (N) users
              ├── (N) mail_accounts
              ├── (N) mails
              ├── (N) tags
              └── (N) mail_tags
```

## 🎨 Özellikler

### Kayıt Sırasında
- ✅ Yeni tenant oluşturulur
- ✅ Kullanıcı tenant'a bağlanır
- ✅ Varsayılan etiketler oluşturulur (teklif, müşteri, fatura)
- ✅ JWT token döner

### Her API İsteğinde
- ✅ Token doğrulanır
- ✅ Tenant ID çıkarılır
- ✅ Tüm sorgular tenant_id ile filtrelenir
- ✅ Kullanıcı sadece kendi verilerini görür

### Mail İşlemleri
- ✅ IMAP mail çekme tenant bazlı
- ✅ SMTP mail gönderme tenant bazlı
- ✅ Gönderilen mailler tenant_id ile kaydedilir

## 🧪 Test

### 1. İki Farklı Tenant Oluştur

```bash
# Tenant 1
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user1@company1.com",
    "password": "pass123",
    "tenantName": "Company 1"
  }'

# Tenant 2
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user2@company2.com",
    "password": "pass123",
    "tenantName": "Company 2"
  }'
```

### 2. Her Tenant İçin Veri Ekle

```bash
# Tenant 1 token ile mail hesabı ekle
curl -X POST http://localhost:5000/api/accounts \
  -H "Authorization: Bearer <tenant1_token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "account1@gmail.com", ...}'

# Tenant 2 token ile mail hesabı ekle
curl -X POST http://localhost:5000/api/accounts \
  -H "Authorization: Bearer <tenant2_token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "account2@gmail.com", ...}'
```

### 3. Veri İzolasyonunu Doğrula

```bash
# Tenant 1 sadece kendi hesaplarını görür
curl http://localhost:5000/api/accounts \
  -H "Authorization: Bearer <tenant1_token>"

# Tenant 2 sadece kendi hesaplarını görür
curl http://localhost:5000/api/accounts \
  -H "Authorization: Bearer <tenant2_token>"
```

## ⚠️ Önemli Notlar

### Üretim Ortamı İçin

1. **JWT_SECRET değiştir**
   ```env
   JWT_SECRET=use_a_very_long_random_string_here
   ```

2. **HTTPS kullan**
   - Token'lar güvenli kanal üzerinden gönderilmeli

3. **Rate limiting ekle**
   - Brute force saldırılarına karşı koruma

4. **Şifre politikası**
   - Minimum 8 karakter
   - Büyük/küçük harf, rakam, özel karakter

5. **Token refresh mekanizması**
   - Uzun süreli oturumlar için refresh token

### Mevcut Veriler

Eğer mevcut verilerin varsa:

```sql
-- Manuel olarak tenant_id ata
UPDATE mail_accounts SET tenant_id = 1 WHERE id IN (...);
UPDATE mails SET tenant_id = 1 WHERE account_id IN (...);
UPDATE tags SET tenant_id = 1 WHERE id IN (...);
UPDATE mail_tags SET tenant_id = 1 WHERE mail_id IN (...);
```

## 🔄 Migration Geri Alma

Eğer multi-tenant yapısını kaldırmak isterseniz:

```sql
ALTER TABLE mail_accounts DROP COLUMN tenant_id;
ALTER TABLE mails DROP COLUMN tenant_id;
ALTER TABLE tags DROP COLUMN tenant_id;
ALTER TABLE mail_tags DROP COLUMN tenant_id;
DROP TABLE users;
DROP TABLE tenants;
```

## 📝 Değişiklik Özeti

**Yeni Dosyalar:**
- `src/types/index.ts` - Tenant, User, Auth tipleri
- `src/utils/auth.ts` - JWT ve bcrypt utilities
- `src/middleware/auth.ts` - Authentication middleware
- `src/routes/authRoutes.ts` - Login/Register endpoints
- `src/routes/*.tenant.ts` - Tenant-aware route'lar
- `src/database/migrations/add-multi-tenant.sql` - Migration

**Güncellenen Dosyalar:**
- `src/database/schema.sql` - Tenant tabloları ve tenant_id alanları
- `src/services/smtpService.ts` - Tenant-aware mail gönderme
- `src/services/mailFetchService.ts` - Tenant-aware mail çekme
- `src/routes/accountRoutes.ts` - Tenant filtreleme
- `src/server.ts` - Auth route ve tenant-aware route'lar
- `package.json` - JWT ve bcrypt bağımlılıkları
- `.env.example` - JWT ayarları

## 🎉 Sonuç

MailCenter artık tam bir **SaaS** uygulaması:

✅ Multi-tenant mimari  
✅ JWT authentication  
✅ Tenant izolasyonu  
✅ Güvenli şifre yönetimi  
✅ API güvenliği  
✅ Ölçeklenebilir yapı  

Her tenant tamamen izole, güvenli ve bağımsız çalışıyor!

# MailCenter Backend

Multi-account email management system backend.

## Setup

1. **Install dependencies:**
```bash
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
```

Edit `.env` with your PostgreSQL credentials.

3. **Create database:**
```bash
createdb mailcenter
```

4. **Run migrations:**
```bash
npm run db:migrate
```

5. **Start development server:**
```bash
npm run dev
```

## API Endpoints

### Accounts
- `POST /api/accounts` - Add new mail account
- `GET /api/accounts` - List all accounts
- `PATCH /api/accounts/:id/toggle` - Toggle account active status
- `DELETE /api/accounts/:id` - Delete account

### Mails
- `GET /api/mails` - List mails (with filters)
  - Query params: `account_id`, `is_read`, `is_starred`, `is_deleted`, `tag_id`, `search`
- `PATCH /api/mails/:id/read` - Mark as read/unread
- `PATCH /api/mails/:id/star` - Star/unstar mail
- `DELETE /api/mails/:id` - Soft delete mail
- `POST /api/mails/:id/tags` - Add tag to mail
- `DELETE /api/mails/:id/tags/:tag_id` - Remove tag from mail

### Tags
- `GET /api/tags` - List all tags
- `POST /api/tags` - Create new tag

### Dashboard
- `GET /api/dashboard/stats` - Get dashboard statistics

## Features

- ✅ IMAP mail fetching with imapflow
- ✅ Automatic mail sync via cron (every 5 minutes)
- ✅ Multi-account support
- ✅ Tag system
- ✅ Read/starred/deleted status
- ✅ Search functionality
- ✅ Dashboard statistics

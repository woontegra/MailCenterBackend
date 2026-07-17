import { Router } from 'express';
import { unsubscribeByToken } from '../services/campaignUnsubscribeService';

const router = Router();

function page(title: string, message: string) {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title}</title>
  <style>
    body{font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;margin:0;padding:32px;color:#15202b}
    main{max-width:520px;margin:48px auto;background:#fff;border:1px solid #e8edf2;border-radius:18px;padding:28px}
    h1{font-size:22px;margin:0 0 12px} p{line-height:1.55;color:#475569}
  </style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`;
}

router.get('/test', (_req, res) => {
  res.type('html').send(page('Test bağlantısı', 'Bu test abonelikten çıkma bağlantısı gerçek bir tercih oluşturmaz.'));
});

router.get('/:token', async (req, res) => {
  const result = await unsubscribeByToken({
    token: String(req.params.token || ''),
    ip: req.ip,
    userAgent: req.get('user-agent') || null,
  });

  if (!result.ok) {
    return res.status(result.status).type('html').send(page('Bağlantı geçersiz', result.message));
  }

  return res.type('html').send(
    page(
      'Abonelikten çıkıldı',
      `${result.maskedEmail} için e-posta abonelikten çıkma tercihi kaydedildi. Geçmiş gönderimler silinmez.`
    )
  );
});

export default router;

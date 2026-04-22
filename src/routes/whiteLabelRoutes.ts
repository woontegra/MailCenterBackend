import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import multer from 'multer';
import s3Service from '../services/s3Service';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

router.use(authenticate);

router.get('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;

    const result = await query(
      'SELECT logo_url, primary_color, secondary_color, custom_domain FROM tenants WHERE id = $1',
      [tenantId]
    );

    res.json(result.rows[0] || {});
  } catch (error: any) {
    console.error('Get white-label settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const { primary_color, secondary_color, custom_domain } = req.body;

    await query(
      `UPDATE tenants 
       SET primary_color = COALESCE($1, primary_color),
           secondary_color = COALESCE($2, secondary_color),
           custom_domain = COALESCE($3, custom_domain)
       WHERE id = $4`,
      [primary_color, secondary_color, custom_domain, tenantId]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Update white-label settings error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/logo', upload.single('logo'), async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const key = await s3Service.uploadFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    const url = await s3Service.getFileUrl(key, 31536000);

    await query(
      'UPDATE tenants SET logo_url = $1 WHERE id = $2',
      [url, tenantId]
    );

    res.json({ logo_url: url });
  } catch (error: any) {
    console.error('Upload logo error:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

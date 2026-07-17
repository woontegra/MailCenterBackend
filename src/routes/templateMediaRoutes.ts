import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { uploadTemplateMediaAsset } from '../services/templateMediaService';
import { TEMPLATE_MEDIA_MAX_BYTES } from '../utils/templateMediaValidation';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TEMPLATE_MEDIA_MAX_BYTES, files: 1 },
});

router.use(authenticate);
router.use(requirePermission('TEMPLATE_MANAGE'));

router.post('/upload', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Dosya seçilmedi' });
    }

    const brandRaw = req.body?.brand_id ?? req.body?.brandId;
    const brandId =
      brandRaw != null && String(brandRaw).trim() !== ''
        ? Number(brandRaw)
        : null;

    if (brandId != null && !Number.isFinite(brandId)) {
      return res.status(400).json({ error: 'Geçersiz marka kimliği' });
    }

    const asset = await uploadTemplateMediaAsset({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      brandId,
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      declaredMime: req.file.mimetype,
    });

    res.status(201).json({
      success: true,
      data: {
        id: asset.id,
        publicUrl: asset.publicUrl,
        originalFileName: asset.originalFileName,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      },
    });
  } catch (error: any) {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: 'Dosya boyutu 2 MB sınırını aşıyor. Daha küçük bir görsel seçin.',
        });
      }
      return res.status(400).json({ error: 'Dosya yüklenemedi' });
    }
    const message = error?.message || 'Görsel yüklenemedi';
    const status = message.includes('Geçersiz') || message.includes('Desteklenmeyen') ? 400 : 500;
    console.error('Template media upload error:', message);
    res.status(status).json({ error: message });
  }
});

export default router;

import { Router, Response } from 'express';
import multer from 'multer';
import { authenticate, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../permissions/requirePermission';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  addContactListMembers,
  buildContactListSampleCsv,
  buildContactListSampleXlsx,
  createContactList,
  deleteContactList,
  exportContactList,
  getContactList,
  listContactListMembers,
  listContactLists,
  removeContactListMember,
  updateContactList,
} from '../services/contactListService';
import {
  applyContactListImport,
  detectImportMapping,
  exportContactListImportResults,
  mergeImportMapping,
  parseContactListFile,
  previewContactListImport,
} from '../services/contactListImportService';
import { previewListEmailAudience } from '../services/campaignRecipientResolver';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

router.use(authenticate);

router.get('/', requirePermission('CONTACT_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const rows = await listContactLists(req.user!.tenantId, {
      q: req.query.q ? String(req.query.q) : undefined,
      active_only: req.query.active_only === 'true',
    });
    res.json({ success: true, data: rows });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Listeler alınamadı' });
  }
});

router.get('/sample-csv', requirePermission('CONTACT_VIEW'), (_req, res) => {
  const buf = buildContactListSampleCsv();
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kisi-listesi-ornek.csv"');
  res.send(buf);
});

router.get('/sample-xlsx', requirePermission('CONTACT_VIEW'), (_req, res) => {
  const buf = buildContactListSampleXlsx();
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="kisi-listesi-ornek.xlsx"');
  res.send(buf);
});

router.post('/', requirePermission('CONTACT_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await createContactList({
      tenantId: req.user!.tenantId,
      userId: req.user!.userId,
      name: req.body.name,
      description: req.body.description,
    });
    res.status(201).json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Oluşturulamadı' });
  }
});

router.get('/:id', requirePermission('CONTACT_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await getContactList(req.user!.tenantId, Number(req.params.id));
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Liste alınamadı' });
  }
});

router.patch('/:id', requirePermission('CONTACT_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const row = await updateContactList(req.user!.tenantId, Number(req.params.id), req.body);
    if (!row) return notFound(res);
    res.json({ success: true, data: row });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Güncellenemedi' });
  }
});

router.delete('/:id', requirePermission('CONTACT_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deleteContactList(req.user!.tenantId, Number(req.params.id));
    if (!ok) return notFound(res);
    res.json({
      success: true,
      message: 'Liste kaldırıldı. Kişiler silinmedi; yalnızca liste üyelikleri kaldırıldı.',
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Silinemedi' });
  }
});

router.get('/:id/members', requirePermission('CONTACT_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const result = await listContactListMembers(req.user!.tenantId, Number(req.params.id), {
      q: req.query.q ? String(req.query.q) : undefined,
      limit,
      offset,
    });
    if (!result) return notFound(res);
    res.json({
      success: true,
      data: result.rows,
      total: result.total,
      limit,
      offset,
      page: Math.floor(offset / limit) + 1,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Üyeler alınamadı' });
  }
});

router.post('/:id/members', requirePermission('CONTACT_MANAGE'), async (req: AuthRequest, res: Response) => {
  try {
    const contactIds = Array.isArray(req.body.contact_ids ?? req.body.contactIds)
      ? (req.body.contact_ids ?? req.body.contactIds).map(Number).filter(Boolean)
      : [];
    if (contactIds.length === 0) return badRequest(res, 'Kişi seçilmedi');
    const result = await addContactListMembers({
      tenantId: req.user!.tenantId,
      listId: Number(req.params.id),
      userId: req.user!.userId,
      contactIds,
    });
    if (!result) return notFound(res);
    res.json({ success: true, data: result });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message || 'Eklenemedi' });
  }
});

router.delete(
  '/:id/members/:contactId',
  requirePermission('CONTACT_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      await removeContactListMember(
        req.user!.tenantId,
        Number(req.params.id),
        Number(req.params.contactId)
      );
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Çıkarılamadı' });
    }
  }
);

router.get('/:id/export', requirePermission('CONTACT_VIEW'), async (req: AuthRequest, res: Response) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
    const buf = await exportContactList(req.user!.tenantId, Number(req.params.id), format);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="kisi-listesi-${req.params.id}.csv"`);
    } else {
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="kisi-listesi-${req.params.id}.xlsx"`);
    }
    res.send(buf);
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Dışa aktarılamadı' });
  }
});

router.post(
  '/:id/imports/preview',
  requirePermission('CONTACT_MANAGE'),
  upload.single('file'),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) return badRequest(res, 'Dosya gerekli');
      const parsed = parseContactListFile(req.file);
      const userMapping = req.body.mapping ? JSON.parse(String(req.body.mapping)) : {};
      const detected = detectImportMapping(parsed.headers);
      const mapping = mergeImportMapping(userMapping, detected);
      const preview = await previewContactListImport({
        tenantId: req.user!.tenantId,
        listId: Number(req.params.id),
        userId: req.user!.userId,
        filename: req.file.originalname,
        rows: parsed.rows,
        mapping,
      });
      res.json({
        success: true,
        data: {
          ...preview,
          headers: parsed.headers,
          detected_mapping: detected,
          applied_mapping: mapping,
          file_kind: parsed.file_kind,
        },
      });
    } catch (error: any) {
      res.status(error.status || 500).json({
        success: false,
        error: error.message || 'Dosya önizlenemedi',
      });
    }
  }
);

router.post(
  '/:id/imports/:importId/apply',
  requirePermission('CONTACT_MANAGE'),
  async (req: AuthRequest, res: Response) => {
    try {
      const result = await applyContactListImport({
        tenantId: req.user!.tenantId,
        listId: Number(req.params.id),
        importId: Number(req.params.importId),
        userId: req.user!.userId,
      });
      if (!result) return notFound(res);
      res.json({ success: true, data: result });
    } catch (error: any) {
      res.status(error.status || 500).json({ success: false, error: error.message || 'Uygulanamadı' });
    }
  }
);

router.get(
  '/:id/imports/:importId/export',
  requirePermission('CONTACT_VIEW'),
  async (req: AuthRequest, res: Response) => {
    try {
      const buf = await exportContactListImportResults(
        req.user!.tenantId,
        Number(req.params.importId)
      );
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="liste-import-sonuc-${req.params.importId}.xlsx"`
      );
      res.send(buf);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message || 'Dışa aktarılamadı' });
    }
  }
);

router.post('/preview-audience', requirePermission('EMAIL_SEND'), async (req: AuthRequest, res: Response) => {
  try {
    const listIds = Array.isArray(req.body.list_ids ?? req.body.listIds)
      ? (req.body.list_ids ?? req.body.listIds).map(Number).filter(Boolean)
      : [];
    if (listIds.length === 0) return badRequest(res, 'En az bir liste seçin');
    const preview = await previewListEmailAudience({
      tenantId: req.user!.tenantId,
      brandId: req.body.brand_id ? Number(req.body.brand_id) : null,
      listIds,
    });
    res.json({ success: true, data: preview });
  } catch (error: any) {
    res.status(error.status || 500).json({ success: false, error: error.message || 'Önizleme başarısız' });
  }
});

export default router;

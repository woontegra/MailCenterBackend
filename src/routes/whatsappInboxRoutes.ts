import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { notFound } from '../utils/channelPlatform';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const brandId = req.query.brand_id ? Number(req.query.brand_id) : null;
    const params: any[] = [tenantId];
    let sql = `
      SELECT im.*,
             b.name AS brand_name,
             c.first_name, c.last_name, c.company_name,
             cc.display_name AS connection_name
      FROM inbound_messages im
      LEFT JOIN brands b ON b.id = im.brand_id AND b.tenant_id = im.tenant_id
      LEFT JOIN contacts c ON c.id = im.contact_id AND c.tenant_id = im.tenant_id
      LEFT JOIN channel_connections cc
        ON cc.id = im.channel_connection_id AND cc.tenant_id = im.tenant_id
      WHERE im.tenant_id = $1 AND im.channel_type = 'WHATSAPP'
    `;
    if (brandId) {
      params.push(brandId);
      sql += ` AND im.brand_id = $${params.length}`;
    }
    sql += ' ORDER BY im.received_at DESC LIMIT 100';

    const result = await query(sql, params);
    res.json({
      success: true,
      data: result.rows.map((row: any) => ({
        id: row.id,
        brand_id: row.brand_id,
        brand_name: row.brand_name,
        channel_connection_id: row.channel_connection_id,
        connection_name: row.connection_name,
        sender_value: row.sender_value,
        recipient_value: row.recipient_value,
        provider_message_id: row.provider_message_id,
        message_type: row.message_type,
        content: row.content,
        media_metadata: row.media_metadata,
        received_at: row.received_at,
        contact_id: row.contact_id,
        contact_name: [row.first_name, row.last_name].filter(Boolean).join(' ') ||
          row.company_name ||
          null,
        status: row.status,
      })),
    });
  } catch (error) {
    console.error('Error listing whatsapp inbox:', error);
    res.status(500).json({ success: false, error: 'Gelen WhatsApp mesajları alınamadı' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT im.*, b.name AS brand_name,
              c.first_name, c.last_name, c.company_name
       FROM inbound_messages im
       LEFT JOIN brands b ON b.id = im.brand_id AND b.tenant_id = im.tenant_id
       LEFT JOIN contacts c ON c.id = im.contact_id AND c.tenant_id = im.tenant_id
       WHERE im.id = $1 AND im.tenant_id = $2 AND im.channel_type = 'WHATSAPP'`,
      [req.params.id, req.user!.tenantId]
    );
    if (result.rows.length === 0) return notFound(res);
    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        ...row,
        contact_name:
          [row.first_name, row.last_name].filter(Boolean).join(' ') ||
          row.company_name ||
          null,
      },
    });
  } catch (error) {
    console.error('Error fetching whatsapp inbox item:', error);
    res.status(500).json({ success: false, error: 'Mesaj alınamadı' });
  }
});

export default router;

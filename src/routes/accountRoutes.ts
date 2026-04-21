import { Router, Response } from 'express';
import { query } from '../config/database';
import { authenticate, AuthRequest } from '../middleware/auth';

const router = Router();

router.use(authenticate);

router.post('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      email,
      company_name,
      imap_host,
      imap_port,
      imap_user,
      imap_password,
      smtp_host,
      smtp_port,
      smtp_user,
      smtp_password,
      smtp_secure
    } = req.body;

    if (!email || !imap_host || !imap_user || !imap_password) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const tenantId = req.user!.tenantId;

    const result = await query(
      `INSERT INTO mail_accounts 
       (name, email, company_name, imap_host, imap_port, imap_user, imap_password, smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure, tenant_id) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [
        name || email, 
        email, 
        company_name, 
        imap_host, 
        imap_port || 993, 
        imap_user, 
        imap_password,
        smtp_host, 
        smtp_port || 587, 
        smtp_user, 
        smtp_password, 
        smtp_secure || false, 
        tenantId
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    console.error('Error creating account:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Account already exists' });
    }
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const tenantId = req.user!.tenantId;
    const result = await query(
      'SELECT * FROM mail_accounts WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching accounts:', error);
    res.status(500).json({ error: 'Failed to fetch accounts' });
  }
});

router.patch('/accounts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { smtp_host, smtp_port, smtp_user, smtp_password, smtp_secure } = req.body;
    const tenantId = req.user!.tenantId;

    const result = await query(
      `UPDATE mail_accounts 
       SET smtp_host = $1, smtp_port = $2, smtp_user = $3, 
           smtp_password = $4, smtp_secure = $5, updated_at = CURRENT_TIMESTAMP
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [smtp_host, smtp_port || 587, smtp_user, smtp_password, smtp_secure || false, id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating account:', error);
    res.status(500).json({ error: 'Failed to update account' });
  }
});

router.patch('/accounts/:id/toggle', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;
    const result = await query(
      `UPDATE mail_accounts 
       SET is_active = NOT is_active, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error toggling account:', error);
    res.status(500).json({ error: 'Failed to toggle account' });
  }
});

router.delete('/accounts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;
    const result = await query(
      'DELETE FROM mail_accounts WHERE id = $1 AND tenant_id = $2 RETURNING *',
      [id, tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    res.json({ message: 'Account deleted successfully' });
  } catch (error) {
    console.error('Error deleting account:', error);
    res.status(500).json({ error: 'Failed to delete account' });
  }
});

export default router;

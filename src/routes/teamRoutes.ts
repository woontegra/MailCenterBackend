import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { query } from '../config/database';
import { badRequest, notFound } from '../utils/channelPlatform';
import { requirePermission, forbidden } from '../permissions/requirePermission';
import {
  TenantRole,
  isTenantRole,
  canAssignTenantRole,
  isPermission,
  PermissionOverride,
  tenantRoleLabelTr,
} from '../permissions/permissionCatalog';
import {
  bumpPermissionVersion,
  countOwners,
  generateInviteToken,
  getOwnedTenantUser,
  replacePermissionOverrides,
} from '../permissions/permissionService';
import { queueTeamInviteEmail } from '../services/teamInviteEmailService';

const router = Router();
router.use(authenticate);
router.use(requirePermission('TEAM_MANAGE'));

function rejectTenantInjection(req: AuthRequest, res: Response): boolean {
  if (
    req.body?.tenantId != null ||
    req.body?.tenant_id != null ||
    req.query?.tenantId != null ||
    req.query?.tenant_id != null
  ) {
    badRequest(res, 'tenantId request üzerinden kabul edilmez');
    return true;
  }
  return false;
}

function sanitizeMember(row: any, overrides: PermissionOverride[] = []) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || null,
    tenant_role: row.tenant_role,
    is_active: row.is_active !== false,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || null,
    permission_overrides: overrides,
  };
}

function sanitizeInvite(row: any) {
  return {
    id: row.id,
    email: row.email,
    tenant_role: row.tenant_role,
    status: row.status,
    invited_by: row.invited_by,
    invited_by_email: row.invited_by_email || null,
    invited_by_name: row.invited_by_name || null,
    expires_at: row.expires_at,
    accepted_at: row.accepted_at,
    created_at: row.created_at,
    email_send_status: row.email_send_status || null,
    email_send_message: row.email_send_message || null,
    permission_overrides: row.permission_overrides || [],
  };
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const result = await query(
      `SELECT id, email, name, tenant_role, COALESCE(is_active, true) AS is_active,
              COALESCE(last_login_at, last_login) AS last_login_at, created_at
       FROM users
       WHERE tenant_id = $1
         AND COALESCE(role, '') <> 'super_admin'
       ORDER BY
         CASE tenant_role
           WHEN 'OWNER' THEN 0 WHEN 'ADMIN' THEN 1 WHEN 'MANAGER' THEN 2
           WHEN 'AGENT' THEN 3 ELSE 4 END,
         email ASC`,
      [tenantId]
    );
    res.json({ success: true, data: result.rows.map((r: any) => sanitizeMember(r)) });
  } catch (error) {
    console.error('Error listing team:', error);
    res.status(500).json({ error: 'Ekip listelenemedi' });
  }
});

router.get('/invites', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const result = await query(
      `SELECT i.*,
              u.email AS invited_by_email,
              u.name AS invited_by_name
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by AND u.tenant_id = i.tenant_id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC`,
      [req.user!.tenantId]
    );
    res.json({ success: true, data: result.rows.map(sanitizeInvite) });
  } catch (error) {
    console.error('Error listing invites:', error);
    res.status(500).json({ error: 'Davetler listelenemedi' });
  }
});

router.post('/invites', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const email = String(req.body.email || '')
      .trim()
      .toLowerCase();
    const tenantRole = String(req.body.tenantRole || req.body.role || 'AGENT').toUpperCase();
    const overridesRaw = req.body.permissionOverrides || req.body.permission_overrides || [];

    if (!email || !email.includes('@')) return badRequest(res, 'Geçerli e-posta gerekli');
    if (!isTenantRole(tenantRole)) return badRequest(res, 'Geçersiz rol');
    if (tenantRole === 'OWNER' && req.user!.tenantRole !== 'OWNER') {
      return forbidden(res, 'OWNER rolü yalnızca OWNER tarafından verilebilir');
    }
    if (
      !req.user!.tenantRole ||
      !canAssignTenantRole({ actorRole: req.user!.tenantRole, targetRole: tenantRole })
    ) {
      return forbidden(res, 'Bu rolü atama yetkiniz yok');
    }

    const existing = await query(
      `SELECT id FROM users WHERE LOWER(email) = $1 AND tenant_id = $2`,
      [email, tenantId]
    );
    if (existing.rows[0]) return badRequest(res, 'Kullanıcı zaten ekipte');

    const pending = await query(
      `SELECT id FROM invites
       WHERE tenant_id = $1 AND LOWER(email) = $2 AND status = 'PENDING'`,
      [tenantId, email]
    );
    if (pending.rows[0]) return badRequest(res, 'Bekleyen davet zaten var');

    const { enforceCountQuota } = await import('../utils/quotaGuards');
    if (!(await enforceCountQuota(res, tenantId, 'max_users'))) return;

    const overrides: PermissionOverride[] = [];
    if (Array.isArray(overridesRaw)) {
      for (const item of overridesRaw) {
        const key = item.permission_key || item.key || item;
        const effect = String(item.effect || 'ALLOW').toUpperCase();
        if (isPermission(key) && (effect === 'ALLOW' || effect === 'DENY')) {
          overrides.push({ permission_key: key, effect: effect as 'ALLOW' | 'DENY' });
        }
      }
    }

    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const insert = await query(
      `INSERT INTO invites (
         email, tenant_id, invited_by, role, tenant_role, token, token_hash,
         expires_at, status, permission_overrides
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'PENDING',$8::jsonb)
       RETURNING *`,
      [
        email,
        tenantId,
        req.user!.userId,
        tenantRole,
        tenantRole,
        hash,
        expiresAt,
        JSON.stringify(overrides),
      ]
    );

    const invite = insert.rows[0];
    const tenant = await query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const inviteUrl = `${frontendBase}/invite/${raw}`;

    const sendResult = await queueTeamInviteEmail({
      tenantId,
      invitedByUserId: req.user!.userId,
      toEmail: email,
      inviteUrl,
      tenantName: tenant.rows[0]?.name || 'Mail Center',
      roleLabel: tenantRoleLabelTr(tenantRole),
    });

    await query(
      `UPDATE invites
       SET email_send_status = $1,
           email_send_message = $2,
           outbound_message_id = $3
       WHERE id = $4 AND tenant_id = $5`,
      [
        sendResult.status,
        sendResult.message,
        sendResult.outboundMessageId,
        invite.id,
        tenantId,
      ]
    );

    const refreshed = await query(
      `SELECT i.*, u.email AS invited_by_email, u.name AS invited_by_name
       FROM invites i
       LEFT JOIN users u ON u.id = i.invited_by
       WHERE i.id = $1 AND i.tenant_id = $2`,
      [invite.id, tenantId]
    );

    res.status(201).json({
      success: true,
      data: sanitizeInvite(refreshed.rows[0]),
      emailQueued: sendResult.queued,
      emailMessage: sendResult.message,
      // raw token only once for UI copy if email failed
      inviteToken: sendResult.queued ? undefined : raw,
    });
  } catch (error: any) {
    if (error.code === '23505') return badRequest(res, 'Bekleyen davet zaten var');
    console.error('Error creating invite:', error);
    res.status(500).json({ error: 'Davet oluşturulamadı' });
  }
});

router.post('/invites/:id/resend', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const inviteResult = await query(
      `SELECT * FROM invites WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (!inviteResult.rows[0]) return notFound(res);
    const invite = inviteResult.rows[0];
    if (invite.status !== 'PENDING') return badRequest(res, 'Yalnızca bekleyen davet yeniden gönderilebilir');
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
      await query(
        `UPDATE invites SET status = 'EXPIRED' WHERE id = $1 AND tenant_id = $2`,
        [invite.id, tenantId]
      );
      return badRequest(res, 'Davet süresi dolmuş');
    }

    const { raw, hash } = generateInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await query(
      `UPDATE invites
       SET token_hash = $1, token = NULL, expires_at = $2
       WHERE id = $3 AND tenant_id = $4`,
      [hash, expiresAt, invite.id, tenantId]
    );

    const tenant = await query(`SELECT name FROM tenants WHERE id = $1`, [tenantId]);
    const frontendBase = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const inviteUrl = `${frontendBase}/invite/${raw}`;

    const sendResult = await queueTeamInviteEmail({
      tenantId,
      invitedByUserId: req.user!.userId,
      toEmail: invite.email,
      inviteUrl,
      tenantName: tenant.rows[0]?.name || 'Mail Center',
      roleLabel: tenantRoleLabelTr(invite.tenant_role || invite.role || 'AGENT'),
    });

    await query(
      `UPDATE invites
       SET email_send_status = $1, email_send_message = $2, outbound_message_id = $3
       WHERE id = $4 AND tenant_id = $5`,
      [sendResult.status, sendResult.message, sendResult.outboundMessageId, invite.id, tenantId]
    );

    res.json({
      success: true,
      emailQueued: sendResult.queued,
      emailMessage: sendResult.message,
      inviteToken: sendResult.queued ? undefined : raw,
    });
  } catch (error) {
    console.error('Error resending invite:', error);
    res.status(500).json({ error: 'Davet yeniden gönderilemedi' });
  }
});

router.delete('/invites/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const result = await query(
      `UPDATE invites
       SET status = 'REVOKED', revoked_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND tenant_id = $2 AND status = 'PENDING'
       RETURNING id`,
      [req.params.id, req.user!.tenantId]
    );
    if (!result.rows[0]) return notFound(res);
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking invite:', error);
    res.status(500).json({ error: 'Davet iptal edilemedi' });
  }
});

router.get('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const member = await getOwnedTenantUser(Number(req.params.userId), req.user!.tenantId);
    if (!member) return notFound(res);
    const overrides = await query(
      `SELECT permission_key, effect FROM user_permission_overrides
       WHERE user_id = $1 AND tenant_id = $2`,
      [member.id, req.user!.tenantId]
    );
    res.json({
      success: true,
      data: sanitizeMember(member, overrides.rows),
    });
  } catch (error) {
    console.error('Error fetching team member:', error);
    res.status(500).json({ error: 'Üye alınamadı' });
  }
});

router.patch('/:userId/role', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const targetId = Number(req.params.userId);
    const nextRole = String(req.body.tenantRole || req.body.role || '').toUpperCase();

    if (!isTenantRole(nextRole)) return badRequest(res, 'Geçersiz rol');
    if (targetId === req.user!.userId) return forbidden(res, 'Kendi rolünüzü değiştiremezsiniz');

    const member = await getOwnedTenantUser(targetId, tenantId);
    if (!member) return notFound(res);

    const actorRole = req.user!.tenantRole;
    if (!actorRole) return forbidden(res);

    if (member.tenant_role === 'OWNER' && nextRole !== 'OWNER') {
      const owners = await countOwners(tenantId);
      if (owners <= 1) {
        return badRequest(res, 'Son OWNER kullanıcısının rolü düşürülemez');
      }
    }

    if (nextRole === 'OWNER' && actorRole !== 'OWNER') {
      return forbidden(res, 'OWNER rolü yalnızca OWNER tarafından verilebilir');
    }

    if (!canAssignTenantRole({ actorRole, targetRole: nextRole as TenantRole })) {
      return forbidden(res, 'Bu rolü atama yetkiniz yok');
    }

    // Cannot elevate to equal/higher than self except OWNER assigning
    if (
      actorRole !== 'OWNER' &&
      member.tenant_role &&
      isTenantRole(member.tenant_role) &&
      !canAssignTenantRole({ actorRole, targetRole: member.tenant_role })
    ) {
      return forbidden(res, 'Bu kullanıcının rolünü değiştiremezsiniz');
    }

    await query(
      `UPDATE users SET tenant_role = $1 WHERE id = $2 AND tenant_id = $3`,
      [nextRole, targetId, tenantId]
    );
    await bumpPermissionVersion(targetId, tenantId);

    const updated = await getOwnedTenantUser(targetId, tenantId);
    res.json({ success: true, data: sanitizeMember(updated) });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ error: 'Rol güncellenemedi' });
  }
});

router.patch('/:userId/permissions', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const targetId = Number(req.params.userId);
    if (targetId === req.user!.userId) {
      return forbidden(res, 'Kendi özel yetkilerinizi bu uç noktadan yönetemezsiniz');
    }

    const member = await getOwnedTenantUser(targetId, tenantId);
    if (!member) return notFound(res);

    const raw = req.body.overrides || req.body.permissionOverrides || [];
    if (!Array.isArray(raw)) return badRequest(res, 'overrides dizi olmalı');

    const overrides: PermissionOverride[] = [];
    for (const item of raw) {
      const key = item.permission_key || item.key;
      const effect = String(item.effect || '').toUpperCase();
      if (!isPermission(key) || (effect !== 'ALLOW' && effect !== 'DENY')) {
        return badRequest(res, 'Geçersiz yetki override');
      }
      overrides.push({ permission_key: key, effect: effect as 'ALLOW' | 'DENY' });
    }

    await replacePermissionOverrides({
      tenantId,
      userId: targetId,
      overrides,
    });

    const refreshed = await query(
      `SELECT permission_key, effect FROM user_permission_overrides
       WHERE user_id = $1 AND tenant_id = $2`,
      [targetId, tenantId]
    );
    res.json({
      success: true,
      data: sanitizeMember(member, refreshed.rows),
    });
  } catch (error) {
    console.error('Error updating permissions:', error);
    res.status(500).json({ error: 'Yetkiler güncellenemedi' });
  }
});

router.patch('/:userId/status', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const targetId = Number(req.params.userId);
    const isActive = Boolean(req.body.isActive ?? req.body.is_active);

    if (targetId === req.user!.userId) {
      return forbidden(res, 'Kendi hesabınızı pasifleştiremezsiniz');
    }

    const member = await getOwnedTenantUser(targetId, tenantId);
    if (!member) return notFound(res);

    if (member.tenant_role === 'OWNER' && !isActive) {
      const owners = await countOwners(tenantId);
      if (owners <= 1) {
        return badRequest(res, 'Son OWNER kullanıcısı pasif yapılamaz');
      }
    }

    await query(
      `UPDATE users SET is_active = $1 WHERE id = $2 AND tenant_id = $3`,
      [isActive, targetId, tenantId]
    );
    await bumpPermissionVersion(targetId, tenantId);

    const updated = await getOwnedTenantUser(targetId, tenantId);
    res.json({ success: true, data: sanitizeMember(updated) });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Durum güncellenemedi' });
  }
});

router.delete('/:userId', async (req: AuthRequest, res: Response) => {
  try {
    if (rejectTenantInjection(req, res)) return;
    const tenantId = req.user!.tenantId;
    const targetId = Number(req.params.userId);

    if (targetId === req.user!.userId) {
      return forbidden(res, 'Kendinizi tenant\'tan silemezsiniz');
    }

    const member = await getOwnedTenantUser(targetId, tenantId);
    if (!member) return notFound(res);

    if (member.tenant_role === 'OWNER') {
      const owners = await countOwners(tenantId);
      if (owners <= 1) {
        return badRequest(res, 'Son OWNER kullanıcısı silinemez');
      }
    }

    // Soft-delete: deactivate rather than hard delete to preserve FK history
    await query(
      `UPDATE users SET is_active = false, permission_version = COALESCE(permission_version,1) + 1
       WHERE id = $1 AND tenant_id = $2`,
      [targetId, tenantId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing team member:', error);
    res.status(500).json({ error: 'Üye kaldırılamadı' });
  }
});

export default router;

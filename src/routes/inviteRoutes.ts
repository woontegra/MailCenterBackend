import { Router, Request, Response } from 'express';
import { query } from '../config/database';
import { hashPassword, generateToken } from '../utils/auth';
import { badRequest, notFound } from '../utils/channelPlatform';
import {
  hashInviteToken,
  loadUserAuthContext,
  replacePermissionOverrides,
} from '../permissions/permissionService';
import { isTenantRole, isPermission, PermissionOverride } from '../permissions/permissionCatalog';
import { normalizeEmail } from '../utils/contactNormalize';

const router = Router();

async function findInviteByRawToken(rawToken: string) {
  const hash = hashInviteToken(rawToken);
  // Prefer hashed lookup; fallback to legacy plaintext token for old rows
  let result = await query(
    `SELECT i.*, t.name AS tenant_name
     FROM invites i
     JOIN tenants t ON t.id = i.tenant_id
     WHERE i.token_hash = $1
     LIMIT 1`,
    [hash]
  );
  if (result.rows.length === 0) {
    result = await query(
      `SELECT i.*, t.name AS tenant_name
       FROM invites i
       JOIN tenants t ON t.id = i.tenant_id
       WHERE i.token = $1
       LIMIT 1`,
      [rawToken]
    );
  }
  return result.rows[0] || null;
}

function inviteIsUsable(invite: any): { ok: boolean; error?: string } {
  if (!invite) return { ok: false, error: 'Davet bulunamadı' };
  if (invite.status === 'REVOKED') return { ok: false, error: 'Davet iptal edilmiş' };
  if (invite.status === 'ACCEPTED' || invite.accepted_at) {
    return { ok: false, error: 'Davet zaten kabul edilmiş' };
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { ok: false, error: 'Davet süresi dolmuş' };
  }
  if (invite.status && invite.status !== 'PENDING') {
    return { ok: false, error: 'Davet kullanılamaz' };
  }
  return { ok: true };
}

router.get('/validate/:token', async (req: Request, res: Response) => {
  try {
    const invite = await findInviteByRawToken(String(req.params.token || ''));
    if (!invite) return notFound(res);

    const usable = inviteIsUsable(invite);
    if (!usable.ok) {
      if (invite.expires_at && new Date(invite.expires_at) < new Date() && invite.status === 'PENDING') {
        await query(`UPDATE invites SET status = 'EXPIRED' WHERE id = $1`, [invite.id]);
      }
      return res.status(400).json({ success: false, error: usable.error });
    }

    res.json({
      success: true,
      data: {
        email: invite.email,
        tenant_name: invite.tenant_name,
        tenant_role: invite.tenant_role || invite.role,
        expires_at: invite.expires_at,
      },
    });
  } catch (error) {
    console.error('Invite validate error:', error);
    res.status(500).json({ success: false, error: 'Davet doğrulanamadı' });
  }
});

router.post('/accept', async (req: Request, res: Response) => {
  try {
    const rawToken = String(req.body.token || '');
    const password = String(req.body.password || '');
    const name = String(req.body.name || '').trim();
    const emailInput = String(req.body.email || '').trim();

    if (!rawToken) return badRequest(res, 'token gerekli');
    if (!password || password.length < 8) {
      return badRequest(res, 'Parola en az 8 karakter olmalı');
    }

    const invite = await findInviteByRawToken(rawToken);
    if (!invite) return notFound(res);

    const usable = inviteIsUsable(invite);
    if (!usable.ok) {
      return res.status(400).json({ success: false, error: usable.error });
    }

    const inviteEmail = normalizeEmail(invite.email);
    if (!inviteEmail.ok) return badRequest(res, 'Davet e-postası geçersiz');

    if (emailInput) {
      const provided = normalizeEmail(emailInput);
      if (!provided.ok || provided.normalized !== inviteEmail.normalized) {
        return badRequest(res, 'E-posta adresi davetteki adresle eşleşmiyor');
      }
    }

    const existing = await query(`SELECT id FROM users WHERE LOWER(email) = $1`, [
      inviteEmail.normalized,
    ]);
    if (existing.rows[0]) {
      return badRequest(res, 'Bu e-posta ile kullanıcı zaten kayıtlı');
    }

    let tenantRole = String(invite.tenant_role || invite.role || 'AGENT').toUpperCase();
    if (!isTenantRole(tenantRole)) tenantRole = 'AGENT';
    // Never accept super_admin via invite
    if (tenantRole === ('SUPER_ADMIN' as any)) tenantRole = 'AGENT';

    const hashed = await hashPassword(password);
    const overridesRaw = invite.permission_overrides || [];
    const overrides: PermissionOverride[] = [];
    if (Array.isArray(overridesRaw)) {
      for (const item of overridesRaw) {
        const key = item.permission_key || item.key;
        const effect = String(item.effect || 'ALLOW').toUpperCase();
        if (isPermission(key) && (effect === 'ALLOW' || effect === 'DENY')) {
          overrides.push({ permission_key: key, effect: effect as 'ALLOW' | 'DENY' });
        }
      }
    }

    await query('BEGIN');
    try {
      const userResult = await query(
        `INSERT INTO users (email, password, name, tenant_id, role, tenant_role, permission_version, is_active)
         VALUES ($1, $2, $3, $4, 'user', $5, 1, true)
         RETURNING id, email, tenant_id`,
        [inviteEmail.normalized, hashed, name || null, invite.tenant_id, tenantRole]
      );
      const user = userResult.rows[0];

      if (overrides.length) {
        await replacePermissionOverrides({
          tenantId: invite.tenant_id,
          userId: user.id,
          overrides,
        });
      }

      await query(
        `UPDATE invites
         SET status = 'ACCEPTED', accepted_at = CURRENT_TIMESTAMP, token = NULL
         WHERE id = $1`,
        [invite.id]
      );

      await query('COMMIT');

      try {
        const { recalculateCountUsage } = await import('../services/entitlementService');
        await recalculateCountUsage(invite.tenant_id);
      } catch {
        /* non-fatal */
      }

      const ctx = await loadUserAuthContext(user.id);
      const token = generateToken({
        userId: user.id,
        email: user.email,
        tenantId: user.tenant_id,
        role: 'user',
        tenantRole: ctx?.tenant_role || tenantRole,
        permissionVersion: ctx?.permission_version || 1,
      });

      res.status(201).json({
        success: true,
        token,
        user: ctx
          ? {
              id: ctx.id,
              email: ctx.email,
              tenant_id: ctx.tenant_id,
              name: ctx.name,
              role: ctx.role,
              tenant_role: ctx.tenant_role,
              permissions: ctx.permissions,
              permission_version: ctx.permission_version,
            }
          : {
              id: user.id,
              email: user.email,
              tenant_id: user.tenant_id,
              tenant_role: tenantRole,
            },
      });
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }
  } catch (error: any) {
    if (error.code === '23505') {
      return badRequest(res, 'Bu e-posta ile kullanıcı zaten kayıtlı');
    }
    console.error('Invite accept error:', error);
    res.status(500).json({ success: false, error: 'Davet kabul edilemedi' });
  }
});

export default router;

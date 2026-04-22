import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { OAuthService } from '../services/oauthService';
import { query } from '../config/database';
import jwt from 'jsonwebtoken';

const router = Router();
const oauthService = new OAuthService();

router.get('/google/auth', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const state = jwt.sign(
      { userId: req.user!.userId, tenantId: req.user!.tenantId },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '10m' }
    );
    const authUrl = oauthService.getGoogleAuthUrl(state);
    res.json({ url: authUrl });
  } catch (error: any) {
    console.error('Google auth URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/accounts?error=missing_params`);
    }

    const decoded = jwt.verify(state as string, process.env.JWT_SECRET || 'secret') as any;
    const tokens = await oauthService.getGoogleTokens(code as string);

    const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    const result = await query(
      `INSERT INTO mail_accounts 
       (tenant_id, name, email, provider, auth_type, access_token, refresh_token, token_expires_at, 
        imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        decoded.tenantId,
        userInfo.name || userInfo.email,
        userInfo.email,
        'gmail',
        'oauth',
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        'imap.gmail.com',
        993,
        userInfo.email,
        'smtp.gmail.com',
        587,
        userInfo.email,
      ]
    );

    await oauthService.saveTokens(result.rows[0].id, 'gmail', tokens);

    res.redirect(`${process.env.FRONTEND_URL}/accounts?success=gmail_connected`);
  } catch (error: any) {
    console.error('Google callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/accounts?error=auth_failed`);
  }
});

router.get('/microsoft/auth', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const state = jwt.sign(
      { userId: req.user!.userId, tenantId: req.user!.tenantId },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '10m' }
    );
    const authUrl = await oauthService.getMicrosoftAuthUrl(state);
    res.json({ url: authUrl });
  } catch (error: any) {
    console.error('Microsoft auth URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/microsoft/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/accounts?error=missing_params`);
    }

    const decoded = jwt.verify(state as string, process.env.JWT_SECRET || 'secret') as any;
    const tokens = await oauthService.getMicrosoftTokens(code as string);

    const userInfoRes = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    const result = await query(
      `INSERT INTO mail_accounts 
       (tenant_id, name, email, provider, auth_type, access_token, refresh_token, token_expires_at,
        imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        decoded.tenantId,
        userInfo.displayName || userInfo.mail,
        userInfo.mail,
        'outlook',
        'oauth',
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        'outlook.office365.com',
        993,
        userInfo.mail,
        'smtp.office365.com',
        587,
        userInfo.mail,
      ]
    );

    await oauthService.saveTokens(result.rows[0].id, 'outlook', tokens);

    res.redirect(`${process.env.FRONTEND_URL}/accounts?success=outlook_connected`);
  } catch (error: any) {
    console.error('Microsoft callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/accounts?error=auth_failed`);
  }
});

router.get('/yahoo/auth', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const state = jwt.sign(
      { userId: req.user!.userId, tenantId: req.user!.tenantId },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '10m' }
    );
    const authUrl = oauthService.getYahooAuthUrl(state);
    res.json({ url: authUrl });
  } catch (error: any) {
    console.error('Yahoo auth URL error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/yahoo/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) {
      return res.redirect(`${process.env.FRONTEND_URL}/accounts?error=missing_params`);
    }

    const decoded = jwt.verify(state as string, process.env.JWT_SECRET || 'secret') as any;
    const tokens = await oauthService.getYahooTokens(code as string);

    const userInfoRes = await fetch('https://api.login.yahoo.com/openid/v1/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();

    const result = await query(
      `INSERT INTO mail_accounts 
       (tenant_id, name, email, provider, auth_type, access_token, refresh_token, token_expires_at,
        imap_host, imap_port, imap_user, smtp_host, smtp_port, smtp_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        decoded.tenantId,
        userInfo.name || userInfo.email,
        userInfo.email,
        'yahoo',
        'oauth',
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_at,
        'imap.mail.yahoo.com',
        993,
        userInfo.email,
        'smtp.mail.yahoo.com',
        587,
        userInfo.email,
      ]
    );

    await oauthService.saveTokens(result.rows[0].id, 'yahoo', tokens);

    res.redirect(`${process.env.FRONTEND_URL}/accounts?success=yahoo_connected`);
  } catch (error: any) {
    console.error('Yahoo callback error:', error);
    res.redirect(`${process.env.FRONTEND_URL}/accounts?error=auth_failed`);
  }
});

export default router;

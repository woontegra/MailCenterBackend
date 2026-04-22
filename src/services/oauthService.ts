import { google } from 'googleapis';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { query } from '../config/database';

export class OAuthService {
  private googleClient: any;
  private msalClient: ConfidentialClientApplication;

  constructor() {
    this.googleClient = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      `${process.env.BACKEND_URL}/api/oauth/google/callback`
    );

    this.msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.MICROSOFT_CLIENT_ID || '',
        clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
        authority: 'https://login.microsoftonline.com/common',
      },
    });
  }

  getGoogleAuthUrl(state: string): string {
    return this.googleClient.generateAuthUrl({
      access_type: 'offline',
      scope: ['https://mail.google.com/'],
      state,
      prompt: 'consent',
    });
  }

  async getGoogleTokens(code: string) {
    const { tokens } = await this.googleClient.getToken(code);
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(tokens.expiry_date),
    };
  }

  async refreshGoogleToken(refreshToken: string) {
    this.googleClient.setCredentials({ refresh_token: refreshToken });
    const { credentials } = await this.googleClient.refreshAccessToken();
    return {
      access_token: credentials.access_token,
      expires_at: new Date(credentials.expiry_date),
    };
  }

  getMicrosoftAuthUrl(state: string): string {
    const authCodeUrlParameters = {
      scopes: ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send', 'offline_access'],
      redirectUri: `${process.env.BACKEND_URL}/api/oauth/microsoft/callback`,
      state,
    };
    return this.msalClient.getAuthCodeUrl(authCodeUrlParameters);
  }

  async getMicrosoftTokens(code: string) {
    const tokenRequest = {
      code,
      scopes: ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send', 'offline_access'],
      redirectUri: `${process.env.BACKEND_URL}/api/oauth/microsoft/callback`,
    };
    const response = await this.msalClient.acquireTokenByCode(tokenRequest);
    return {
      access_token: response.accessToken,
      refresh_token: response.refreshToken,
      expires_at: new Date(Date.now() + (response.expiresIn || 3600) * 1000),
    };
  }

  async refreshMicrosoftToken(refreshToken: string) {
    const tokenRequest = {
      refreshToken,
      scopes: ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send'],
    };
    const response = await this.msalClient.acquireTokenByRefreshToken(tokenRequest);
    return {
      access_token: response.accessToken,
      expires_at: new Date(Date.now() + (response.expiresIn || 3600) * 1000),
    };
  }

  getYahooAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: process.env.YAHOO_CLIENT_ID || '',
      redirect_uri: `${process.env.BACKEND_URL}/api/oauth/yahoo/callback`,
      response_type: 'code',
      scope: 'mail-r mail-w',
      state,
    });
    return `https://api.login.yahoo.com/oauth2/request_auth?${params}`;
  }

  async getYahooTokens(code: string) {
    const response = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        code,
        redirect_uri: `${process.env.BACKEND_URL}/api/oauth/yahoo/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async refreshYahooToken(refreshToken: string) {
    const response = await fetch('https://api.login.yahoo.com/oauth2/get_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${Buffer.from(`${process.env.YAHOO_CLIENT_ID}:${process.env.YAHOO_CLIENT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const data = await response.json();
    return {
      access_token: data.access_token,
      expires_at: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async saveTokens(accountId: number, provider: string, tokens: any) {
    await query(
      `INSERT INTO oauth_tokens (account_id, provider, access_token, refresh_token, expires_at, scope)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE
       SET access_token = $3, refresh_token = $4, expires_at = $5, updated_at = CURRENT_TIMESTAMP`,
      [accountId, provider, tokens.access_token, tokens.refresh_token, tokens.expires_at, tokens.scope || '']
    );

    await query(
      `UPDATE mail_accounts 
       SET access_token = $1, refresh_token = $2, token_expires_at = $3, auth_type = 'oauth', updated_at = CURRENT_TIMESTAMP
       WHERE id = $4`,
      [tokens.access_token, tokens.refresh_token, tokens.expires_at, accountId]
    );
  }

  async refreshExpiredTokens() {
    const result = await query(
      `SELECT id, provider, refresh_token FROM mail_accounts 
       WHERE auth_type = 'oauth' AND token_expires_at < NOW() + INTERVAL '5 minutes' AND refresh_token IS NOT NULL`
    );

    for (const account of result.rows) {
      try {
        let newTokens;
        switch (account.provider) {
          case 'gmail':
            newTokens = await this.refreshGoogleToken(account.refresh_token);
            break;
          case 'outlook':
            newTokens = await this.refreshMicrosoftToken(account.refresh_token);
            break;
          case 'yahoo':
            newTokens = await this.refreshYahooToken(account.refresh_token);
            break;
          default:
            continue;
        }

        await this.saveTokens(account.id, account.provider, { ...newTokens, refresh_token: account.refresh_token });
        console.log(`✓ Refreshed token for account ${account.id}`);
      } catch (error) {
        console.error(`✗ Failed to refresh token for account ${account.id}:`, error);
      }
    }
  }
}

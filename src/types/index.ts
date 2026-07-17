export interface Tenant {
  id: number;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: number;
  email: string;
  password: string;
  tenant_id: number;
  created_at: Date;
  updated_at: Date;
}

export interface MailAccount {
  id: number;
  name: string;
  email: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: string;
  imap_secure?: boolean;
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_password?: string;
  smtp_secure?: boolean;
  tenant_id?: number;
  is_active: boolean;
  imap_connection_status?: string;
  smtp_connection_status?: string;
  last_connection_test_at?: Date;
  provider?: string;
  auth_type?: string;
  access_token?: string;
  refresh_token?: string;
  token_expires_at?: Date;
  last_sync_uid?: number;
  last_sync_at?: Date;
  sync_status?: string;
  sync_error?: string;
  imap_uidvalidity?: number | null;
  last_inbound_at?: Date | null;
  imap_idle_status?: string | null;
  imap_idle_error?: string | null;
  imap_connected_at?: Date | null;
  imap_listener_active?: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Mail {
  id?: number;
  account_id: number;
  message_id: string;
  subject: string;
  from_address: string;
  to_address: string;
  cc_address?: string | null;
  date: Date;
  body_preview: string;
  html_body?: string | null;
  text_body?: string | null;
  attachment_meta?: any;
  is_read: boolean;
  is_starred: boolean;
  is_deleted: boolean;
  is_sent: boolean;
  tenant_id?: number;
  raw_headers?: any;
  created_at?: Date;
  updated_at?: Date;
}

export interface Tag {
  id: number;
  name: string;
  color: string;
  tenant_id?: number;
  created_at: Date;
}

export interface FetchedMessage {
  messageId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string | null;
  date: Date;
  bodyPreview: string;
  htmlBody?: string | null;
  textBody?: string | null;
  attachmentMeta?: Array<{
    filename?: string;
    contentType?: string;
    sizeBytes?: number;
    contentId?: string;
    disposition?: string;
    inline?: boolean;
  }>;
  headers: any;
  uid?: number;
  envelope?: any;
  inReplyTo?: string | null;
  references?: string | null;
}

export interface SendMailRequest {
  accountId: number;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text?: string;
  html?: string;
  fromName?: string;
  fromEmail?: string;
  replyTo?: string;
}

export interface SendMailResponse {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  tenantName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  user?: {
    id: number;
    email: string;
    tenant_id: number;
  };
  error?: string;
}

export interface AuthPayload {
  userId: number;
  email: string;
  tenantId: number;
  /** Platform role */
  role?: string;
  tenantRole?: string;
  permissionVersion?: number;
}

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
  smtp_host?: string;
  smtp_port?: number;
  smtp_user?: string;
  smtp_password?: string;
  smtp_secure?: boolean;
  tenant_id?: number;
  is_active: boolean;
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
  date: Date;
  body_preview: string;
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
  date: Date;
  bodyPreview: string;
  headers: any;
}

export interface SendMailRequest {
  accountId: number;
  to: string;
  subject: string;
  text?: string;
  html?: string;
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
}

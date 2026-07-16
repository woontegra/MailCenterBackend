import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const CONNECTION_TIMEOUT_MS = 15_000;

export type MailConnectionTestInput = {
  email?: string;
  imap_host: string;
  imap_port: number;
  imap_user: string;
  imap_password: string;
  imap_secure?: boolean;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_user?: string | null;
  smtp_password?: string | null;
  smtp_secure?: boolean;
};

export type MailConnectionTestResult = {
  success: boolean;
  imap_ok: boolean;
  smtp_ok: boolean;
  error?: 'incomplete_config' | 'timeout' | 'connection_failed';
};

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function testImap(input: MailConnectionTestInput): Promise<boolean> {
  const client = new ImapFlow({
    host: input.imap_host,
    port: Number(input.imap_port) || 993,
    secure: input.imap_secure !== false,
    auth: {
      user: input.imap_user,
      pass: input.imap_password,
    },
    logger: false,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: CONNECTION_TIMEOUT_MS,
  });

  try {
    await withTimeout(client.connect(), CONNECTION_TIMEOUT_MS);
    try {
      await withTimeout(client.logout(), 5_000);
    } catch {
      // ignore logout failures after successful connect
    }
    return true;
  } catch {
    try {
      client.close();
    } catch {
      // ignore
    }
    return false;
  }
}

async function testSmtp(input: MailConnectionTestInput): Promise<boolean> {
  if (!input.smtp_host || !input.smtp_user || !input.smtp_password) {
    return false;
  }

  const transporter = nodemailer.createTransport({
    host: input.smtp_host,
    port: Number(input.smtp_port) || 587,
    secure: Boolean(input.smtp_secure),
    auth: {
      user: input.smtp_user,
      pass: input.smtp_password,
    },
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: CONNECTION_TIMEOUT_MS,
    socketTimeout: CONNECTION_TIMEOUT_MS,
  });

  try {
    await withTimeout(transporter.verify(), CONNECTION_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  } finally {
    transporter.close();
  }
}

export async function testMailConnection(
  input: MailConnectionTestInput
): Promise<MailConnectionTestResult> {
  if (!input.imap_host || !input.imap_user || !input.imap_password) {
    return {
      success: false,
      imap_ok: false,
      smtp_ok: false,
      error: 'incomplete_config',
    };
  }

  const hasSmtp =
    Boolean(input.smtp_host) && Boolean(input.smtp_user) && Boolean(input.smtp_password);

  let imap_ok = false;
  let smtp_ok = false;
  let timedOut = false;

  try {
    imap_ok = await testImap(input);
  } catch (error: any) {
    if (error?.message === 'TIMEOUT') timedOut = true;
    imap_ok = false;
  }

  if (hasSmtp) {
    try {
      smtp_ok = await testSmtp(input);
    } catch (error: any) {
      if (error?.message === 'TIMEOUT') timedOut = true;
      smtp_ok = false;
    }
  } else {
    smtp_ok = false;
  }

  const success = imap_ok && (!hasSmtp || smtp_ok);

  return {
    success,
    imap_ok,
    smtp_ok: hasSmtp ? smtp_ok : false,
    error: success ? undefined : timedOut ? 'timeout' : 'connection_failed',
  };
}

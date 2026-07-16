import { encryptCredential, decryptCredential } from '../utils/mailCredentialsCrypto';
import { SmsCredentials } from './SmsProviderAdapter';

export type SmsConnectionSettings = {
  default_msgheader?: string | null;
  encoding?: 'TR' | 'ASCII' | null;
  iysfilter?: string | null;
};

export function packSmsCredentials(input: {
  username?: string;
  password?: string;
  appname?: string | null;
}): string {
  const username = String(input.username || '').trim();
  const password = String(input.password || '').trim();
  if (!username || !password) {
    throw Object.assign(new Error('Netgsm kullanıcı adı ve parola gerekli'), {
      code: 'INVALID_CREDENTIALS',
    });
  }
  const payload: SmsCredentials = {
    username,
    password,
    appname: input.appname ? String(input.appname).trim() : null,
  };
  return encryptCredential(JSON.stringify(payload));
}

export function unpackSmsCredentials(encrypted: string | null | undefined): SmsCredentials {
  if (!encrypted) {
    throw Object.assign(new Error('SMS kimlik bilgileri eksik'), {
      code: 'MISSING_CREDENTIALS',
    });
  }
  const raw = decryptCredential(encrypted);
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('SMS kimlik bilgileri okunamadı'), {
      code: 'INVALID_CREDENTIALS',
    });
  }
  const username = String(parsed.username || parsed.usercode || '').trim();
  const password = String(parsed.password || '').trim();
  if (!username || !password) {
    throw Object.assign(new Error('SMS kimlik bilgileri eksik'), {
      code: 'INVALID_CREDENTIALS',
    });
  }
  return {
    username,
    password,
    appname: parsed.appname ? String(parsed.appname).trim() : null,
  };
}

/** Merge patch: keep existing password when new password blank. */
export function mergeSmsCredentialUpdate(params: {
  existingEncrypted: string | null;
  username?: string | null;
  password?: string | null;
  appname?: string | null;
}): string | null {
  const hasUsername = params.username != null && String(params.username).trim() !== '';
  const hasPassword = params.password != null && String(params.password).trim() !== '';
  const hasAppname = params.appname !== undefined;

  if (!hasUsername && !hasPassword && !hasAppname) {
    return params.existingEncrypted;
  }

  let current: SmsCredentials | null = null;
  if (params.existingEncrypted) {
    try {
      current = unpackSmsCredentials(params.existingEncrypted);
    } catch {
      current = null;
    }
  }

  const username = hasUsername
    ? String(params.username).trim()
    : current?.username || '';
  const password = hasPassword
    ? String(params.password).trim()
    : current?.password || '';
  const appname = hasAppname
    ? params.appname
      ? String(params.appname).trim()
      : null
    : current?.appname ?? null;

  if (!username || !password) {
    throw Object.assign(new Error('Netgsm kullanıcı adı ve parola gerekli'), {
      code: 'INVALID_CREDENTIALS',
    });
  }

  return packSmsCredentials({ username, password, appname });
}

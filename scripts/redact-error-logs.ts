/**
 * Maintenance: redact sensitive keys in legacy error_logs.request_body JSON.
 *
 * Default: dry-run (counts only, no writes, never prints secret values).
 * Apply:   npx ts-node scripts/redact-error-logs.ts --apply
 */
import dotenv from 'dotenv';
dotenv.config();

import { pool } from '../src/config/database';

const SENSITIVE_KEY_PATTERN =
  /password|passwd|secret|token|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|encryption|imap_password|smtp_password/i;

const APPLY = process.argv.includes('--apply');

function redactSensitive(value: unknown, depth = 0): { value: unknown; changed: boolean } {
  if (depth > 8 || value == null) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const r = redactSensitive(item, depth + 1);
      if (r.changed) changed = true;
      return r.value;
    });
    return { value: next, changed };
  }
  if (typeof value === 'object') {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        if (val !== '[REDACTED]') changed = true;
        out[key] = '[REDACTED]';
      } else {
        const r = redactSensitive(val, depth + 1);
        if (r.changed) changed = true;
        out[key] = r.value;
      }
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

function bodyLooksSensitive(raw: unknown): boolean {
  if (raw == null) return false;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return false;
    try {
      parsed = JSON.parse(s);
    } catch {
      return SENSITIVE_KEY_PATTERN.test(s);
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > 8 || node == null) return false;
    if (Array.isArray(node)) return node.some((n) => walk(n, depth + 1));
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (SENSITIVE_KEY_PATTERN.test(k) && v !== '[REDACTED]') return true;
        if (walk(v, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(parsed, 0);
}

async function main() {
  console.log(
    APPLY
      ? 'Mode: APPLY (will update matching error_logs rows)'
      : 'Mode: DRY-RUN (no database writes). Pass --apply to redact.'
  );

  const result = await pool.query(
    `SELECT id, request_body
     FROM error_logs
     WHERE request_body IS NOT NULL
       AND request_body::text <> ''
       AND request_body::text <> 'null'`
  );

  let candidateCount = 0;
  let wouldChange = 0;
  let updated = 0;

  for (const row of result.rows) {
    const raw = row.request_body;
    if (!bodyLooksSensitive(raw)) continue;
    candidateCount += 1;

    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Non-JSON body that matched key pattern in string form — skip mutation of opaque text
        continue;
      }
    }

    const redacted = redactSensitive(parsed);
    if (!redacted.changed) continue;
    wouldChange += 1;

    if (APPLY) {
      await pool.query(
        `UPDATE error_logs SET request_body = $1::jsonb WHERE id = $2`,
        [JSON.stringify(redacted.value), row.id]
      );
      updated += 1;
    }
  }

  console.log(`Rows scanned: ${result.rows.length}`);
  console.log(`Rows with potential sensitive keys: ${candidateCount}`);
  console.log(`Rows needing redaction: ${wouldChange}`);
  if (APPLY) {
    console.log(`Rows updated: ${updated}`);
  } else {
    console.log('No rows modified (dry-run).');
  }

  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('redact-error-logs failed:', err instanceof Error ? err.message : 'unknown');
  try {
    await pool.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});

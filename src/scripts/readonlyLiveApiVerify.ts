/** Live API verification — no secrets logged. */
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';

dotenv.config();

async function main() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const u = await c.query(
    `SELECT id, email, tenant_id, role, tenant_role, permission_version
     FROM users WHERE tenant_id = 5 AND is_active = true ORDER BY id LIMIT 1`
  );
  const user = u.rows[0];
  if (!user) throw new Error('No active tenant-5 user');

  const token = jwt.sign(
    {
      userId: user.id,
      email: user.email,
      tenantId: user.tenant_id,
      role: user.role,
      tenantRole: user.tenant_role,
      permissionVersion: user.permission_version,
    },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );

  await c.end();

  const base = process.env.PUBLIC_BACKEND_URL || 'https://mailcenterbackend-production.up.railway.app';
  const url = `${base}/api/channel-connections?brand_id=6&channel_type=WHATSAPP`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const body = await res.json();
  const rows = Array.isArray(body) ? body : [];
  const hit = rows.find((x: any) => Number(x.id) === 12);

  console.log(
    JSON.stringify(
      {
        http_status: res.status,
        whatsapp_count: rows.length,
        connection_12_present: Boolean(hit),
        connection_12: hit
          ? {
              id: hit.id,
              brand_id: hit.brand_id,
              status: hit.status,
              phone_number: hit.phone_number,
              phone_number_id: hit.phone_number_id,
              waba_id: hit.waba_id,
              is_shared: hit.is_shared,
              has_credentials: hit.has_credentials,
            }
          : null,
        api_error: Array.isArray(body) ? null : body,
      },
      null,
      2
    )
  );

  if (res.status !== 200 || !hit) process.exit(1);
}

main().catch((e) => {
  console.error('API verify failed:', e.message);
  process.exit(1);
});

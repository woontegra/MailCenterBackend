/** READ-ONLY post-migration verify. */
import dotenv from 'dotenv';
import { Client } from 'pg';

dotenv.config();

async function main() {
  const c = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await c.connect();

  const shares = await c.query('SELECT COUNT(*)::int AS n FROM channel_connection_brand_shares');
  const idx = await c.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'channel_connection_brand_shares' ORDER BY indexname`
  );
  const cons = await c.query(
    `SELECT conname, contype FROM pg_constraint WHERE conrelid = 'channel_connection_brand_shares'::regclass ORDER BY conname`
  );
  const conv = await c.query('SELECT COUNT(*)::int AS n FROM conversations');
  const inb = await c.query('SELECT COUNT(*)::int AS n FROM inbound_messages');

  console.log(
    JSON.stringify(
      {
        share_rows: shares.rows[0].n,
        indexes: idx.rows.map((r) => r.indexname),
        constraints: cons.rows,
        post_conversations: conv.rows[0].n,
        post_inbound_messages: inb.rows[0].n,
      },
      null,
      2
    )
  );
  await c.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

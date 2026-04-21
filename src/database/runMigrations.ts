import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const migrations = [
  'schema.sql',
  'schema_upgrade.sql',
  'add_company_name.sql',
  'mail_operations_upgrade.sql',
];

async function runMigrations() {
  console.log('🚀 Starting database migrations...\n');

  try {
    await pool.query('SELECT NOW()');
    console.log('✓ Database connected\n');

    for (const migration of migrations) {
      const filePath = path.join(__dirname, migration);
      
      if (!fs.existsSync(filePath)) {
        console.log(`⚠️  Skipping ${migration} (file not found)`);
        continue;
      }

      console.log(`📝 Running migration: ${migration}`);
      
      const sql = fs.readFileSync(filePath, 'utf-8');
      
      await pool.query(sql);
      
      console.log(`✓ Completed: ${migration}\n`);
    }

    console.log('🎉 All migrations completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();

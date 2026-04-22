import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execAsync = promisify(exec);

export class BackupService {
  private backupDir = path.join(__dirname, '../../backups');

  constructor() {
    if (!fs.existsSync(this.backupDir)) {
      fs.mkdirSync(this.backupDir, { recursive: true });
    }
  }

  async createBackup(): Promise<string> {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `backup-${timestamp}.sql`;
      const filepath = path.join(this.backupDir, filename);

      const dbUrl = process.env.DATABASE_URL;
      if (!dbUrl) {
        throw new Error('DATABASE_URL not configured');
      }

      await execAsync(`pg_dump ${dbUrl} > ${filepath}`);

      console.log(`✓ Backup created: ${filename}`);
      return filepath;
    } catch (error) {
      console.error('✗ Backup failed:', error);
      throw error;
    }
  }

  async cleanOldBackups(daysToKeep: number = 7): Promise<void> {
    try {
      const files = fs.readdirSync(this.backupDir);
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filepath = path.join(this.backupDir, file);
        const stats = fs.statSync(filepath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          fs.unlinkSync(filepath);
          console.log(`✓ Deleted old backup: ${file}`);
        }
      }
    } catch (error) {
      console.error('✗ Cleanup failed:', error);
    }
  }

  async listBackups(): Promise<string[]> {
    try {
      const files = fs.readdirSync(this.backupDir);
      return files.filter(f => f.endsWith('.sql')).sort().reverse();
    } catch (error) {
      console.error('✗ List backups failed:', error);
      return [];
    }
  }
}

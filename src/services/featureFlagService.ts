import { query } from '../config/database';
import cacheService from './cacheService';

export class FeatureFlagService {
  async isEnabled(featureName: string, tenantId?: number): Promise<boolean> {
    const cacheKey = cacheService.generateKey('feature', featureName, tenantId || 'global');
    const cached = await cacheService.get<boolean>(cacheKey);
    
    if (cached !== null) {
      return cached;
    }

    let result;
    if (tenantId) {
      result = await query(
        'SELECT enabled FROM feature_flags WHERE name = $1 AND (tenant_id = $2 OR tenant_id IS NULL) ORDER BY tenant_id DESC LIMIT 1',
        [featureName, tenantId]
      );
    } else {
      result = await query(
        'SELECT enabled FROM feature_flags WHERE name = $1 AND tenant_id IS NULL',
        [featureName]
      );
    }

    const enabled = result.rows.length > 0 ? result.rows[0].enabled : false;
    await cacheService.set(cacheKey, enabled, 300);
    
    return enabled;
  }

  async setFlag(featureName: string, enabled: boolean, tenantId?: number) {
    await query(
      `INSERT INTO feature_flags (name, enabled, tenant_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET enabled = $2, updated_at = CURRENT_TIMESTAMP`,
      [featureName, enabled, tenantId || null]
    );

    const cacheKey = cacheService.generateKey('feature', featureName, tenantId || 'global');
    await cacheService.del(cacheKey);
  }

  async listFlags(tenantId?: number) {
    const result = await query(
      'SELECT * FROM feature_flags WHERE tenant_id = $1 OR tenant_id IS NULL ORDER BY name',
      [tenantId || null]
    );
    return result.rows;
  }
}

export default new FeatureFlagService();

import { Response } from 'express';
import {
  assertFeatureEnabled,
  assertUsageAvailable,
  recalculateCountUsage,
  respondEntitlementError,
  FeatureKey,
  LimitKey,
} from '../services/entitlementService';

/** Assert quota before create. Returns false if response already sent. */
export async function enforceCountQuota(
  res: Response,
  tenantId: number,
  limitKey: LimitKey
): Promise<boolean> {
  try {
    await assertUsageAvailable(tenantId, limitKey, 1);
    return true;
  } catch (error) {
    if (respondEntitlementError(res, error)) return false;
    throw error;
  }
}

export async function afterCountResourceCreated(tenantId: number) {
  await recalculateCountUsage(tenantId);
}

/** Assert plan feature is enabled. Returns false if response already sent. */
export async function enforceFeature(
  res: Response,
  tenantId: number,
  feature: FeatureKey
): Promise<boolean> {
  try {
    await assertFeatureEnabled(tenantId, feature);
    return true;
  } catch (error) {
    if (respondEntitlementError(res, error)) return false;
    throw error;
  }
}

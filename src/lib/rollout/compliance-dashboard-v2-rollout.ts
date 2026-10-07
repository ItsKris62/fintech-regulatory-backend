import { prisma } from '@/lib/prisma/client';
import { redis } from '@/lib/redis/client';

export type V2RolloutMode = 'OFF' | 'ALLOWLIST' | 'ON';

export interface V2RolloutMetadata {
  rolloutMode?: V2RolloutMode;
  allowedOrgIds?: string[];
}

export async function isComplianceDashboardV2Enabled(orgId: string): Promise<boolean> {
  // 1. Emergency environment kill switch overrides all other states
  if (
    process.env.COMPLIANCE_DASHBOARD_V2_DISABLED === 'true' ||
    process.env.NEXT_PUBLIC_COMPLIANCE_DASHBOARD_V2_DISABLED === 'true'
  ) {
    return false;
  }

  const cacheKey = `sheriabot:flag:compliance_dashboard_v2:${orgId}`;
  const cached = await redis.get<boolean>(cacheKey).catch(() => null);
  if (cached !== null) {
    return cached;
  }

  try {
    const flag = await prisma.featureFlag.findUnique({
      where: { name: 'compliance_dashboard_v2' },
      select: { enabled: true, metadata: true },
    });

    if (!flag || !flag.enabled) {
      await redis.set(cacheKey, false, { ex: 60 }).catch(() => null);
      return false;
    }

    const metadata = (flag.metadata as V2RolloutMetadata | null) ?? {};
    const rolloutMode = metadata.rolloutMode ?? 'ALLOWLIST';

    let enabled = false;
    if (rolloutMode === 'ON') {
      enabled = true;
    } else if (rolloutMode === 'ALLOWLIST') {
      const allowed = Array.isArray(metadata.allowedOrgIds) ? metadata.allowedOrgIds : [];
      enabled = allowed.includes(orgId);
    } else {
      // OFF or unknown mode fails closed
      enabled = false;
    }

    await redis.set(cacheKey, enabled, { ex: 60 }).catch(() => null);
    return enabled;
  } catch {
    // Fail closed on error
    return false;
  }
}

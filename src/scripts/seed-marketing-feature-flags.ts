/**
 * Seed Script: Marketing Feature Flags
 *
 * Seeds the FeatureFlag records required by the Marketing & Outreach module.
 * Safe to run multiple times — uses ON CONFLICT DO NOTHING semantics via upsert.
 *
 * Usage:
 *   pnpm seed:marketing:flags
 *
 * Flags seeded:
 *   marketing_utm_tracking — When enabled, marketing email links are tagged
 *                            with UTM parameters for analytics tracking.
 *                            Disabled by default (enable only when an analytics
 *                            tool is configured to receive the parameters).
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as never);

const MARKETING_FLAGS = [
  {
    name:        'marketing_utm_tracking',
    enabled:     false,
    category:    'marketing',
    description: 'When enabled, marketing email links are tagged with UTM parameters for analytics tracking. Disable when no analytics tool is configured.',
  },
] as const;

async function seedMarketingFeatureFlags(): Promise<void> {
  console.log('\n🚩 Seeding marketing feature flags...\n');

  for (const flag of MARKETING_FLAGS) {
    const existing = await prisma.featureFlag.findUnique({
      where: { name: flag.name },
    });

    if (existing) {
      console.log(`  ⚠️  FeatureFlag '${flag.name}' already exists — skipping`);
      continue;
    }

    await prisma.featureFlag.create({
      data: {
        name:        flag.name,
        enabled:     flag.enabled,
        category:    flag.category,
        description: flag.description,
      },
    });

    console.log(`  ✅ Created FeatureFlag '${flag.name}' (enabled: ${flag.enabled})`);
  }

  console.log('\n🎉 Marketing feature flags seeded successfully!\n');
  console.log('   To enable UTM tracking, set marketing_utm_tracking = true');
  console.log('   in the admin Feature Flags panel.\n');
}

seedMarketingFeatureFlags()
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Seed failed:', message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

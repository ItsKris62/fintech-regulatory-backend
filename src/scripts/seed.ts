import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Idempotent production seed script.
 * Creates default admin user, feature flags, and system configs.
 * Safe to run multiple times — uses upserts.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const prisma = new (PrismaClient as any)();

async function seed(): Promise<void> {
  console.log('🌱 Starting production seed...\n');

  // ── 1. Default admin user ──────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sheriabot.co.ke';
  const adminPassword = process.env.ADMIN_PASSWORD || 'SheriaBot-Admin-2024!';

  const hashedPassword = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      password: hashedPassword,
      fullName: 'System Admin',
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
    },
  });

  console.log(`  ✅ Admin user: ${admin.email} (${admin.id})`);

  // ── 2. Default feature flags ───────────────────────────────────────────
  const featureFlags = [
    { name: 'maintenance_mode', enabled: false, description: 'Enable maintenance mode' },
    { name: 'ai_policy_generation', enabled: true, description: 'Enable AI policy generation' },
    { name: 'document_upload', enabled: true, description: 'Enable document upload' },
    { name: 'compliance_queries', enabled: true, description: 'Enable compliance queries' },
    { name: 'email_notifications', enabled: true, description: 'Enable email notifications' },
    { name: 'rate_limiting', enabled: true, description: 'Enable rate limiting' },
  ];

  for (const flag of featureFlags) {
    await prisma.featureFlag.upsert({
      where: { name: flag.name },
      update: {},
      create: flag,
    });
  }

  console.log(`  ✅ Feature flags: ${featureFlags.length} seeded`);

  // ── 3. Default system configs ──────────────────────────────────────────
  const systemConfigs = [
    { key: 'max_upload_size_mb', value: '50', description: 'Maximum file upload size in MB' },
    { key: 'max_policies_per_user', value: '100', description: 'Maximum policies per user' },
    { key: 'ai_daily_cost_limit', value: '10.00', description: 'Daily AI cost limit in USD' },
    { key: 'session_timeout_hours', value: '24', description: 'Session timeout in hours' },
    { key: 'password_min_length', value: '8', description: 'Minimum password length' },
  ];

  for (const config of systemConfigs) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: {},
      create: config,
    });
  }

  console.log(`  ✅ System configs: ${systemConfigs.length} seeded`);

  console.log('\n🎉 Production seed complete!\n');
}

seed()
  .catch((err) => {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

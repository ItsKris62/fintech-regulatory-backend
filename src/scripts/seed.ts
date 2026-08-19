import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import bcrypt from 'bcryptjs';

/**
 * Idempotent production seed script.
 * Creates default admin user, feature flags, and system configs.
 * Safe to run multiple times  -  uses upserts.
 */


async function seed(): Promise<void> {
  console.log('🌱 Starting production seed...\n');

  // -- 1. Default admin user ----------------------------------------------
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@sheriabot.com';
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    throw new Error('ADMIN_PASSWORD is required; no default admin password is allowed.');
  }

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

  // -- 2. Default feature flags -------------------------------------------
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

  // -- 3. Default system configs ------------------------------------------
  const systemConfigs = [
    { key: 'max_upload_size_mb', value: '50', type: 'number', category: 'storage', description: 'Maximum file upload size in MB' },
    { key: 'max_queries_per_hour', value: '50', type: 'number', category: 'ai', description: 'Maximum compliance queries per user per hour' },
    { key: 'max_policies_per_hour', value: '10', type: 'number', category: 'ai', description: 'Maximum policy generations per user per hour' },
    { key: 'ai_daily_cost_limit', value: '500', type: 'number', category: 'ai', description: 'Daily AI cost limit in USD' },
    { key: 'ai_policy_model', value: 'claude-sonnet-4-6', type: 'string', category: 'ai', description: 'Default policy generation model' },
    { key: 'ai_query_model', value: 'claude-haiku-4-5-20251001', type: 'string', category: 'ai', description: 'Default compliance query model' },
    { key: 'ai_policy_temperature', value: '0.3', type: 'number', category: 'ai', description: 'Policy generation temperature' },
    { key: 'ai_query_temperature', value: '0.5', type: 'number', category: 'ai', description: 'Compliance query temperature' },
    { key: 'session_timeout_hours', value: '8', type: 'number', category: 'security', description: 'Absolute session timeout in hours' },
    { key: 'password_min_length', value: '10', type: 'number', category: 'security', description: 'Minimum password length' },
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

/**
 * Seed Script: Admin Account
 *
 * Creates an admin user in both Supabase Auth and Prisma.
 * Safe to run multiple times — skips if the email already exists.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@yourcompany.com ADMIN_PASSWORD=YourPass123! pnpm seed:admin
 *
 * Or use defaults (set in .env or below):
 *   pnpm seed:admin
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter } as never);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL || 'admin@sheriabot.com';
  const password = process.env.ADMIN_PASSWORD || 'SheriaBot-Admin-2024!';
  const fullName = process.env.ADMIN_NAME || 'System Admin';

  console.log(`\n🔐 Creating admin account: ${email}\n`);

  // ── 1. Check if already exists in Prisma ──────────────────────────────────
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`  ⚠️  User already exists in DB (id: ${existing.id})`);
    if (existing.role !== 'ADMIN') {
      await prisma.user.update({ where: { email }, data: { role: 'ADMIN' } });
      console.log('  ✅ Role upgraded to ADMIN');
    } else {
      console.log('  ℹ️  Already has ADMIN role — nothing to do');
    }
    return;
  }

  // ── 2. Create in Supabase Auth ─────────────────────────────────────────────
  const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,   // skip email verification for admin
    user_metadata: { role: 'ADMIN', fullName },
  });

  if (authError || !authData?.user) {
    // Check if user already exists in Supabase but not in Prisma (orphaned)
    if (authError?.message?.includes('already been registered') || authError?.code === 'email_exists') {
      console.log('  ℹ️  Supabase user already exists — checking for orphaned Prisma record...');
      // List users to find the supabase ID
      const { data: listData } = await supabaseAdmin.auth.admin.listUsers();
      const supabaseUser = listData?.users?.find((u: any) => u.email === email);
      if (!supabaseUser) {
        throw new Error('Could not locate existing Supabase user');
      }
      const hashedPw = await bcrypt.hash(password, 12);
      const user = await prisma.user.create({
        data: {
          supabaseAuthId: supabaseUser.id,
          email,
          password: hashedPw,
          fullName,
          role: 'ADMIN',
          status: 'ACTIVE',
          emailVerified: true,
          accountStatus: 'active',
        } as any,
      });
      console.log(`  ✅ Admin user created in DB (id: ${user.id})`);
      return;
    }
    throw new Error(`Supabase error: ${authError?.message ?? 'unknown'}`);
  }

  // ── 3. Create in Prisma ────────────────────────────────────────────────────
  const hashedPw = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: {
      supabaseAuthId: authData.user.id,
      email,
      password: hashedPw,
      fullName,
      role: 'ADMIN',
      status: 'ACTIVE',
      emailVerified: true,
      accountStatus: 'active',
    } as any,
  });

  console.log(`  ✅ Supabase Auth user created (id: ${authData.user.id})`);
  console.log(`  ✅ Prisma user created (id: ${user.id})`);
  console.log(`\n🎉 Admin account ready!\n`);
  console.log(`   Email:    ${email}`);
  console.log(`   Password: ${password}`);
  console.log(`   Role:     ADMIN\n`);
}

seedAdmin()
  .catch((err) => {
    console.error('❌ Seed failed:', err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

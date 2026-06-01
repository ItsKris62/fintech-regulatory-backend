/**
 * Seed Script: Admin Account
 *
 * Creates or repairs an admin user in both Supabase Auth and Prisma.
 * Safe to run multiple times.
 *
 * Usage:
 *   ADMIN_EMAIL=admin@yourcompany.com ADMIN_PASSWORD=YourPass123! pnpm seed:admin
 *
 * Or use defaults from .env:
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

async function findSupabaseUserByEmail(email: string) {
  let page = 1;
  const perPage = 1000;

  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Supabase list users failed: ${error.message}`);

    const user = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (user) return user;
    if (data.users.length < perPage) return null;

    page += 1;
  }
}

async function seedAdmin(): Promise<void> {
  const email = process.env.ADMIN_EMAIL || 'admin@sheriabot.com';
  const password = process.env.ADMIN_PASSWORD || 'SheriaBot-Admin-2024!';
  const fullName = process.env.ADMIN_NAME || 'System Admin';

  console.log(`\nCreating or repairing admin account: ${email}\n`);

  let supabaseUser = await findSupabaseUserByEmail(email);

  if (supabaseUser) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(supabaseUser.id, {
      email_confirm: true,
      password,
      user_metadata: { ...(supabaseUser.user_metadata ?? {}), role: 'ADMIN', fullName },
    });
    if (error) throw new Error(`Supabase update failed: ${error.message}`);
    console.log(`  OK Supabase Auth user updated (${supabaseUser.id})`);
  } else {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { role: 'ADMIN', fullName },
    });
    if (error || !data.user) throw new Error(`Supabase create failed: ${error?.message ?? 'unknown'}`);

    supabaseUser = data.user;
    console.log(`  OK Supabase Auth user created (${supabaseUser.id})`);
  }

  const hashedPw = await bcrypt.hash(password, 12);
  const existing = await prisma.user.findUnique({ where: { email } });

  if (existing) {
    await prisma.user.update({
      where: { email },
      data: {
        supabaseAuthId: supabaseUser.id,
        password: hashedPw,
        fullName: existing.fullName || fullName,
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerified: true,
        emailVerifiedAt: (existing as any).emailVerifiedAt ?? new Date(),
        accountStatus: 'active',
        deletedAt: null,
      } as any,
    });
    console.log(`  OK Prisma user repaired (${existing.id})`);
  } else {
    const user = await prisma.user.create({
      data: {
        supabaseAuthId: supabaseUser.id,
        email,
        password: hashedPw,
        fullName,
        role: 'ADMIN',
        status: 'ACTIVE',
        emailVerified: true,
        emailVerifiedAt: new Date(),
        accountStatus: 'active',
      } as any,
    });
    console.log(`  OK Prisma user created (${user.id})`);
  }

  console.log('\nAdmin account ready');
  console.log(`   Email: ${email}`);
  console.log('   Role:  ADMIN\n');
}

seedAdmin()
  .catch((err) => {
    console.error('Seed failed:', err.message || err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

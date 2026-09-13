import 'dotenv/config';
import { prisma } from '../lib/prisma/client';

async function main() {
  console.log('Applying additive columns to isolated dev DB...');
  
  // 1. Extend SubscriptionPlan enum values
  try {
    await prisma.$executeRawUnsafe(`ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'FREE';`);
    await prisma.$executeRawUnsafe(`ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'STARTER';`);
    await prisma.$executeRawUnsafe(`ALTER TYPE "SubscriptionPlan" ADD VALUE IF NOT EXISTS 'GROWTH';`);
  } catch (e: any) {
    console.log('Enum check note:', e.message);
  }

  // 2. Add additive columns to Organization
  await prisma.$executeRawUnsafe(`
    ALTER TABLE "Organization" 
      ADD COLUMN IF NOT EXISTS "enabledJurisdictions" TEXT[] DEFAULT ARRAY[]::TEXT[],
      ADD COLUMN IF NOT EXISTS "needsCountryConfirmation" BOOLEAN DEFAULT FALSE;
  `);

  // 3. Add index
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "Organization_needsCountryConfirmation_idx" ON "Organization"("needsCountryConfirmation");
  `);

  console.log('Additive migration applied successfully to isolated database.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  });

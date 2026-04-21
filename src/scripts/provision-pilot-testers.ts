/**
 * Pilot Tester Provisioning Script
 *
 * Creates Supabase Auth invitations and corresponding Prisma User + Organization
 * records for each pilot tester defined in pilot-testers.config.ts.
 *
 * Design invariants:
 *   - Idempotent: testers whose email already exists in the DB are skipped.
 *   - One Organization per tester (per Q3 architectural decision) to enforce
 *     RLS isolation and clean conversion path post-pilot.
 *   - Organization.plan is left at REGULATOR. The withPlanContext middleware
 *     overrides to ENTERPRISE for active pilots via User.isPilot + pilotExpiresAt
 *     (Option A: derived override, no Org mutation).
 *   - role is set to ENTERPRISE (the spec listed BUSINESS which is not a valid
 *     UserRole enum value; ENTERPRISE is the closest valid equivalent for
 *     testers receiving Enterprise-tier access).
 *
 * Usage:
 *   # Dry run (default -- safe, no DB or Auth changes):
 *   pnpm tsx src/scripts/provision-pilot-testers.ts
 *   pnpm tsx src/scripts/provision-pilot-testers.ts --dry-run
 *
 *   # Execute:
 *   pnpm tsx src/scripts/provision-pilot-testers.ts --execute
 *
 * Prerequisites:
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL must be set
 *     (via .env or environment).
 *   - SQL from Task 1 must have been run in Supabase (adds isPilot etc. columns).
 *   - pilot-testers.config.ts must be populated with tester data.
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PILOT_TESTERS } from './pilot-testers.config';
import type { PilotTester } from './pilot-testers.config';

// -- Clients (created directly to avoid dragging in the full app config) -------

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma  = new PrismaClient({ adapter } as never);

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// -- CLI flags -----------------------------------------------------------------

const args    = process.argv.slice(2);
const DRY_RUN = !args.includes('--execute');

// -- Result tracking -----------------------------------------------------------

interface TesterResult {
  email:   string;
  status:  'created' | 'skipped' | 'failed';
  reason?: string;
}

// -- Core provisioning logic ---------------------------------------------------

async function provisionTester(tester: PilotTester, dryRun: boolean): Promise<TesterResult> {
  const { email, name, organization, cohort } = tester;

  // 1. Check if already provisioned in Prisma
  const existing = await prisma.user.findUnique({
    where:  { email },
    select: { id: true, isPilot: true },
  });

  if (existing) {
    console.log(`  ⏭️  ${email}  -  already exists (userId: ${existing.id})`);
    return { email, status: 'skipped', reason: 'User record already exists in DB' };
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would provision: ${name} <${email}> @ ${organization} (${cohort})`);
    return { email, status: 'created' };
  }

  // 2. Send Supabase Auth invitation
  const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(
    email,
    {
      redirectTo: 'https://app.sheriabot.com/onboarding',
      data:       { fullName: name, organization, pilotCohort: cohort },
    }
  );

  if (inviteError || !inviteData?.user?.id) {
    const reason = inviteError?.message ?? 'Supabase invite returned no user ID';
    console.error(`  ❌ ${email}  -  Supabase invite failed: ${reason}`);
    return { email, status: 'failed', reason };
  }

  const supabaseAuthId = inviteData.user.id;

  // 3. Create isolated Organization for this tester
  let org: { id: string };
  try {
    org = await (prisma as any).organization.create({
      data: {
        name:               organization,
        type:               'enterprise',
        organizationType:   'enterprise',
        subscriptionTier:   'REGULATOR',
        subscriptionStatus: 'ACTIVE',
        // plan defaults to REGULATOR in schema -- middleware overrides to
        // ENTERPRISE for active pilots (Option A derived override).
        verificationStatus: 'verified',
        verifiedAt:         new Date(),
      },
      select: { id: true },
    });
  } catch (orgErr: unknown) {
    const reason = orgErr instanceof Error ? orgErr.message : String(orgErr);
    console.error(`  ❌ ${email}  -  Organization create failed: ${reason}`);
    return { email, status: 'failed', reason: `Org create: ${reason}` };
  }

  // 4. Create Prisma User record linked to the Organization
  const now            = new Date();
  const pilotExpiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // +14 days

  try {
    const user = await (prisma as any).user.create({
      data: {
        supabaseAuthId,
        email,
        fullName:        name,
        role:            'ENTERPRISE', // spec listed BUSINESS; ENTERPRISE is the valid enum equivalent
        status:          'ACTIVE',
        accountStatus:   'active',
        emailVerified:   true,         // invite flow handles verification
        organizationId:  org.id,
        // Pilot fields
        isPilot:         true,
        pilotCohort:     cohort,
        pilotStartedAt:  now,
        pilotExpiresAt,
        postPilotTier:   'REGULATOR',
      },
      select: { id: true },
    });

    console.log(`  ✅ ${email}  -  provisioned (userId: ${user.id}, orgId: ${org.id}, expires: ${pilotExpiresAt.toISOString().slice(0, 10)})`);
    return { email, status: 'created' };
  } catch (userErr: unknown) {
    const reason = userErr instanceof Error ? userErr.message : String(userErr);
    console.error(`  ❌ ${email}  -  User create failed: ${reason}`);
    return { email, status: 'failed', reason: `User create: ${reason}` };
  }
}

// -- Main ----------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n========================================================');
  console.log('  SheriaBot  -  Pilot Tester Provisioning');
  console.log('========================================================\n');

  if (PILOT_TESTERS.length === 0) {
    console.log('  ⚠️  No testers found in pilot-testers.config.ts');
    console.log('      Add tester entries and re-run.\n');
    return;
  }

  if (DRY_RUN) {
    console.log('  MODE: DRY RUN  -  no Supabase invites or DB writes will occur.');
    console.log('  Pass --execute to apply changes.\n');
  } else {
    console.log('  MODE: EXECUTE  -  Supabase invites and DB writes WILL occur.\n');
  }

  // Group by cohort for the summary header
  const cohorts = [...new Set(PILOT_TESTERS.map((t) => t.cohort))];
  console.log(`  Cohort(s):  ${cohorts.join(', ')}`);
  console.log(`  Testers:    ${PILOT_TESTERS.length}`);
  console.log('');

  const results: TesterResult[] = [];

  // Process testers sequentially to avoid overwhelming DB / Supabase rate limits
  for (const tester of PILOT_TESTERS) {
    const result = await provisionTester(tester, DRY_RUN);
    results.push(result);
  }

  // -- Summary table ----------------------------------------------------------
  const created = results.filter((r) => r.status === 'created').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const failed  = results.filter((r) => r.status === 'failed').length;

  const cohortLabel = cohorts.length === 1 ? cohorts[0] : cohorts.join(' + ');

  console.log('\n========================================================');
  console.log(`  Pilot Provisioning Summary${DRY_RUN ? ' (DRY RUN)' : ''} -- ${cohortLabel}`);
  console.log('========================================================');
  console.log(`  ✅ Created:              ${created}`);
  console.log(`  ⏭️  Skipped (existing):  ${skipped}`);
  console.log(`  ❌ Failed:               ${failed}`);
  console.log('========================================================\n');

  if (failed > 0) {
    console.log('  Failed testers:');
    results
      .filter((r) => r.status === 'failed')
      .forEach((r) => console.log(`    - ${r.email}: ${r.reason ?? 'unknown error'}`));
    console.log('');
    process.exit(1);
  }
}

main()
  .catch((err: unknown) => {
    console.error('\n❌ Provisioning script crashed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await (prisma as any).$disconnect();
  });

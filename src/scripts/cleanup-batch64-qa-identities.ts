import 'dotenv/config';

import { prisma } from '../lib/prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { adminModule } from '../modules/admin/admin.module';

async function main() {
  const admin = await prisma.user.findFirst({
    where: { role: 'ADMIN', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!admin) throw new Error('No active admin is available for audited QA cleanup.');

  const authPage = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (authPage.error) throw authPage.error;
  const authUsers = (authPage.data?.users ?? []).filter(
    (user) => user.user_metadata?.qaPurpose === 'batch_6_4_acceptance',
  );
  let authDeleted = 0;
  for (const authUser of authUsers) {
    const result = await supabaseAdmin.auth.admin.deleteUser(authUser.id);
    if (result.error) throw result.error;
    authDeleted += 1;
  }

  const dbUsers = await prisma.user.findMany({
    where: { fullName: 'SheriaBot QA Batch 6.4 Pilot', deletedAt: null },
    select: { id: true },
  });
  let dbUsersDeleted = 0;
  for (const user of dbUsers) {
    await adminModule.signOutUserEverywhere(admin.id, user.id);
    await adminModule.deleteUser(admin.id, user.id, 'Batch 6.4 disposable acceptance identity cleanup');
    dbUsersDeleted += 1;
  }

  const qaOrganization = await prisma.organization.findFirst({
    where: { name: 'SheriaBot QA Batch 6.4 Sandbox' },
    select: { id: true, subscriptionStatus: true },
  });
  let organizationScheduledForDeletion = 0;
  if (qaOrganization && qaOrganization.subscriptionStatus !== 'CANCELLED') {
    await adminModule.deleteOrganization(
      admin.id,
      qaOrganization.id,
      'Batch 6.4 disposable acceptance organization cleanup',
    );
    organizationScheduledForDeletion = 1;
  }

  console.log(JSON.stringify({ authDeleted, dbUsersDeleted, organizationScheduledForDeletion }));
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    await prisma.$disconnect();
    process.exit(1);
  });

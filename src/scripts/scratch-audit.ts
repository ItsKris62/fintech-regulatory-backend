import { prisma } from '@/lib/prisma/client';

async function runAudit() {
  const manualOwners = await prisma.organizationMember.findMany({
    where: {
      role: 'OWNER',
      invitedBy: { not: null }
    },
    include: {
      user: {
        select: {
          email: true,
          fullName: true,
          createdAt: true
        }
      },
      organization: {
        select: {
          name: true
        }
      }
    }
  });

  console.log(`Found ${manualOwners.length} owners created via manual admin flow:`);
  manualOwners.forEach((m: any) => {
    console.log(`- ${m.user.email} (${m.user.fullName}) in org "${m.organization.name}" [Created: ${m.user.createdAt.toISOString()}]`);
  });

  await (prisma as any).$disconnect();
}

runAudit().catch(console.error);

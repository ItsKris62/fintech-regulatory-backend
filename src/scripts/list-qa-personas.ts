import 'dotenv/config';
import { prisma } from '../lib/prisma/client';

async function main() {
  const users = await prisma.user.findMany({
    where: { deletedAt: null },
    select: {
      id: true,
      email: true,
      role: true,
      isPilot: true,
      status: true,
      organizationId: true,
      organization: { select: { id: true, name: true, plan: true } },
    },
  });
  console.log('Active users count:', users.length);
  for (const u of users) {
    console.log(`- ${u.email} | role: ${u.role} | isPilot: ${u.isPilot} | plan: ${u.organization?.plan} | org: ${u.organization?.name}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());

import { PrismaClient, MemberRole } from '@prisma/client';
import { logger } from '../utils/logger';

const prisma = new PrismaClient();

const TARGET_EMAILS = [
  'chiwacych.cc@outlook.com',
  'otienonoel@outlook.com'
];
const TARGET_ORG_NAME = 'KOSHI';

async function downgradeOwners() {
  console.log('Starting downgrade script...');

  try {
    // 1. Find the KOSHI organization
    const org = await prisma.organization.findFirst({
      where: { name: TARGET_ORG_NAME }
    });

    if (!org) {
      console.error(`Organization "${TARGET_ORG_NAME}" not found. Exiting.`);
      process.exit(1);
    }

    // 2. Find the users
    const users = await prisma.user.findMany({
      where: { email: { in: TARGET_EMAILS } }
    });

    if (users.length !== TARGET_EMAILS.length) {
      console.warn(`Warning: Found ${users.length} users out of ${TARGET_EMAILS.length} expected.`);
    }

    const userIds = users.map(u => u.id);

    // 3. Find the memberships that are OWNER
    const memberships = await prisma.organizationMember.findMany({
      where: {
        organizationId: org.id,
        userId: { in: userIds },
        role: MemberRole.OWNER
      },
      include: {
        user: true
      }
    });

    if (memberships.length === 0) {
      console.log('No users with OWNER role found to downgrade. Exiting.');
      process.exit(0);
    }

    // 4. Perform the downgrade in a transaction
    await prisma.$transaction(async (tx) => {
      for (const member of memberships) {
        // Update the role to MEMBER
        await tx.organizationMember.update({
          where: {
            userId_organizationId: {
              userId: member.userId,
              organizationId: member.organizationId
            }
          },
          data: {
            role: MemberRole.MEMBER
          }
        });

        console.log(`Downgraded ${member.user.email} from OWNER to MEMBER.`);

        // Log the audit event
        logger.info({
          type: 'manual_role_downgrade',
          targetUserId: member.userId,
          organizationId: member.organizationId,
          previousRole: MemberRole.OWNER,
          newRole: MemberRole.MEMBER,
          reason: 'Correction of unintended OWNER assignment from manual admin creation bug',
        });
      }
    });

    console.log('Downgrade completed successfully.');
  } catch (error) {
    console.error('Error during downgrade:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// To run this script, explicitly call the execute parameter or run it directly after review.
downgradeOwners();

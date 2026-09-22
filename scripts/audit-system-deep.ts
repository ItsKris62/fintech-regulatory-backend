import { prisma } from '../src/lib/prisma/client';
import { supabaseAdmin } from '../src/lib/supabase';
import { redis } from '../src/lib/redis/client';
import * as fs from 'fs';
import * as path from 'path';

async function runAudit() {
  const result: any = {};

  const configs = await prisma.systemConfig.findMany();
  result.systemConfig = configs;

  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      accountStatus: true,
      emailVerified: true,
      emailVerifiedAt: true,
      status: true,
      organizationId: true,
      supabaseAuthId: true,
      createdAt: true,
      lastLoginAt: true,
      organization: {
        select: {
          id: true,
          name: true,
          type: true,
          plan: true,
          subscriptionTier: true,
        }
      },
      _count: {
        select: {
          sessions: true,
          organizationMemberships: true,
        }
      }
    },
    orderBy: { createdAt: 'asc' }
  });
  result.users = users;

  const orgs = await prisma.organization.findMany({
    include: {
      members: {
        select: {
          id: true,
          userId: true,
          role: true,
          status: true,
        }
      },
      _count: {
        select: {
          users: true,
          checklists: true,
          policies: true,
          vaultDocuments: true,
        }
      }
    }
  });
  result.organizations = orgs;

  const sessions = await prisma.session.findMany({
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      createdAt: true,
      device: true,
    }
  });
  result.sessions = sessions;

  try {
    const { data: { users: sbUsers }, error: sbError } = await supabaseAdmin.auth.admin.listUsers();
    if (sbError) {
      result.supabaseAuthError = sbError;
    } else {
      result.supabaseUsers = sbUsers?.map(u => ({
        id: u.id,
        email: u.email,
        email_confirmed_at: u.email_confirmed_at,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        user_metadata: u.user_metadata,
      }));
    }
  } catch (err: any) {
    result.supabaseAuthException = err.message;
  }

  try {
    result.redisPing = await redis.ping();
  } catch (err: any) {
    result.redisError = err.message;
  }

  result.entityCounts = {
    regulatoryFrameworks: await prisma.regulatoryFramework.count(),
    checklists: await prisma.checklist.count(),
    complianceQueries: await prisma.complianceQuery.count(),
    gapAnalyses: await prisma.gapAnalysis.count(),
    policies: await prisma.policy.count(),
    vaultDocuments: await prisma.vaultDocument.count(),
  };

  const outputPath = path.resolve(__dirname, '../../audit-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Audit saved successfully to ${outputPath}`);

  await prisma.$disconnect();
}

runAudit().catch(err => {
  console.error('Audit fatal error:', err);
  process.exit(1);
});

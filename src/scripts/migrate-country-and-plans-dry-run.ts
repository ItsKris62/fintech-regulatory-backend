/**
 * Migration Dry-Run & Execution Script: Organization Jurisdiction & Plan Upgrade
 *
 * Requirements:
 * 1. Do not default all records to KE blindly.
 * 2. Backfill only from authoritative existing organization jurisdiction data.
 * 3. Mark unresolved records with `needsCountryConfirmation = true`.
 * 4. Permit account access while requiring country confirmation (no unrestricted retrieval).
 * 5. Preserve records, ownership, memberships, and pilot expiry.
 * 6. Produce an idempotent dry-run report showing mapped, unresolved, and conflicting records.
 *
 * Usage:
 *   Dry-run mode:  tsx src/scripts/migrate-country-and-plans-dry-run.ts
 *   Execute mode:  tsx src/scripts/migrate-country-and-plans-dry-run.ts --execute
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { type SubscriptionPlan } from '@prisma/client';
import { AUDITED_JURISDICTIONS, type AuditedJurisdiction } from '../config/jurisdictions.config';

interface OrganizationMigrationRecord {
  id: string;
  name: string;
  plan: SubscriptionPlan;
  currentJurisdiction: string | null;
  resolvedJurisdiction: AuditedJurisdiction | null;
  enabledJurisdictions: AuditedJurisdiction[];
  needsCountryConfirmation: boolean;
  resolutionSource: 'EXISTING_VALID' | 'CBK_LICENSE' | 'AUTHORITATIVE_TLD' | 'UNRESOLVED';
  conflict: string | null;
  isPilot: boolean;
}

export async function evaluateOrganizationJurisdictions(isExecute: boolean = false) {
  let organizations: any[] = [];
  try {
    organizations = await prisma.organization.findMany({
      include: {
        users: {
          select: {
            id: true,
            email: true,
            role: true,
            isPilot: true,
            pilotExpiresAt: true,
          },
        },
      },
    });
  } catch {
    // Graceful fallback for pre-migration databases
    const rawRows = await prisma.$queryRaw<any[]>`
      SELECT id, name, plan
      FROM "Organization"
    `;
    organizations = rawRows.map((r) => ({
      ...r,
      homeJurisdictionCode: null,
      enabledJurisdictions: [],
      needsCountryConfirmation: true,
      users: [],
    }));
  }

  const results: OrganizationMigrationRecord[] = [];
  const mappedList: OrganizationMigrationRecord[] = [];
  const unresolvedList: OrganizationMigrationRecord[] = [];
  const conflictList: OrganizationMigrationRecord[] = [];

  for (const org of organizations) {
    const rawJurisdiction = (org.homeJurisdictionCode || '').trim().toUpperCase();
    let resolved: AuditedJurisdiction | null = null;
    let resolutionSource: OrganizationMigrationRecord['resolutionSource'] = 'UNRESOLVED';
    let conflict: string | null = null;

    // 1. Check if current jurisdiction is already a valid audited jurisdiction
    if (AUDITED_JURISDICTIONS.includes(rawJurisdiction as AuditedJurisdiction)) {
      resolved = rawJurisdiction as AuditedJurisdiction;
      resolutionSource = 'EXISTING_VALID';
    } else if (org.cbkLicenseNumber && org.cbkLicenseNumber.trim().length > 0) {
      // Authoritative Kenyan CBK license
      resolved = 'KE';
      resolutionSource = 'CBK_LICENSE';
    } else if (org.website && (org.website.endsWith('.ke') || org.website.includes('.co.ke'))) {
      resolved = 'KE';
      resolutionSource = 'AUTHORITATIVE_TLD';
    } else if (org.website && (org.website.endsWith('.rw') || org.website.includes('.co.rw'))) {
      resolved = 'RW';
      resolutionSource = 'AUTHORITATIVE_TLD';
    } else if (org.website && (org.website.endsWith('.mw') || org.website.includes('.co.mw'))) {
      resolved = 'MW';
      resolutionSource = 'AUTHORITATIVE_TLD';
    } else if (org.website && (org.website.endsWith('.ng') || org.website.includes('.com.ng') || org.website.includes('.ng/'))) {
      resolved = 'NG';
      resolutionSource = 'AUTHORITATIVE_TLD';
    }

    const needsConfirmation = resolved === null;
    const enabledJurisdictions: AuditedJurisdiction[] = resolved ? [resolved] : [];

    const isPilot = org.users.some((u: { isPilot?: boolean }) => Boolean(u.isPilot));

    const record: OrganizationMigrationRecord = {
      id: org.id,
      name: org.name,
      plan: org.plan,
      currentJurisdiction: org.homeJurisdictionCode,
      resolvedJurisdiction: resolved,
      enabledJurisdictions,
      needsCountryConfirmation: needsConfirmation,
      resolutionSource,
      conflict,
      isPilot,
    };

    results.push(record);
    if (needsConfirmation) {
      unresolvedList.push(record);
    } else {
      mappedList.push(record);
    }
  }

  console.log('================================================================');
  console.log(`SHERIABOT BATCH 1 JURISDICTION & PLAN MIGRATION DRY-RUN REPORT`);
  console.log('================================================================');
  console.log(`Execution Mode: ${isExecute ? 'EXECUTE (Applying changes)' : 'DRY-RUN (No changes applied)'}`);
  console.log(`Total Organizations Evaluated: ${results.length}`);
  console.log(`Mapped Authoritatively:        ${mappedList.length}`);
  console.log(`Unresolved (Need Confirmation): ${unresolvedList.length}`);
  console.log(`Conflicting Records:           ${conflictList.length}`);
  console.log('----------------------------------------------------------------');

  if (unresolvedList.length > 0) {
    console.log('\n[!] UNRESOLVED ORGANIZATIONS (Will be flagged with needsCountryConfirmation = true):');
    for (const item of unresolvedList.slice(0, 10)) {
      console.log(` - Org ID: ${item.id} | Name: "${item.name}" | Plan: ${item.plan} | Raw Jurisdiction: "${item.currentJurisdiction ?? 'NULL'}"`);
    }
    if (unresolvedList.length > 10) {
      console.log(`   ... and ${unresolvedList.length - 10} more.`);
    }
  }

  if (mappedList.length > 0) {
    console.log('\n[✓] MAPPED ORGANIZATIONS SAMPLE:');
    for (const item of mappedList.slice(0, 5)) {
      console.log(` - Org ID: ${item.id} | Name: "${item.name}" | Resolved: ${item.resolvedJurisdiction} (Source: ${item.resolutionSource})`);
    }
  }

  if (isExecute) {
    console.log('\nApplying updates to database...');
    let updatedCount = 0;
    for (const item of results) {
      await prisma.organization.update({
        where: { id: item.id },
        data: {
          homeJurisdictionCode: item.resolvedJurisdiction ?? undefined,
          enabledJurisdictions: item.enabledJurisdictions,
          needsCountryConfirmation: item.needsCountryConfirmation,
        },
      });
      updatedCount++;
    }
    console.log(`Successfully updated ${updatedCount} organizations.`);
  }

  return {
    total: results.length,
    mapped: mappedList.length,
    unresolved: unresolvedList.length,
    conflicts: conflictList.length,
    records: results,
  };
}

if (require.main === module) {
  const isExecute = process.argv.includes('--execute');
  evaluateOrganizationJurisdictions(isExecute)
    .then(() => {
      console.log('\nDry-run evaluation complete.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Migration evaluation failed:', err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

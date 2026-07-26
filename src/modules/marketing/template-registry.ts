/**
 * Marketing Template Registry
 *
 * Maps MarketingTemplateKey enum values to:
 *   - The React component to render
 *   - A Zod schema that validates templateVariables from the DB
 *
 * IMPORTANT: unsubscribeUrl, recipientFirstName, and recipientEmail are
 * NEVER stored in templateVariables — they are injected by the send pipeline
 * at render time. The Zod schemas here validate only the admin-supplied
 * campaign variables.
 *
 * This protects against mis-configured templateVariables (admin error or
 * DB tampering) before any email is rendered or sent.
 */

import React from 'react';
import { z } from 'zod';
import { MarketingTemplateKey } from '@prisma/client';

import PilotInvitationEmail from '@/emails/templates/marketing/PilotInvitationEmail';
import RegulatorAccessProgramEmail from '@/emails/templates/marketing/RegulatorAccessProgramEmail';
import ProductLaunchEmail from '@/emails/templates/marketing/ProductLaunchEmail';
import ComplianceUpdateEmail from '@/emails/templates/marketing/ComplianceUpdateEmail';
import WebinarInviteEmail from '@/emails/templates/marketing/WebinarInviteEmail';
import ResourceDownloadEmail from '@/emails/templates/marketing/ResourceDownloadEmail';
import GenericMarketingEmail from '@/emails/templates/marketing/GenericMarketingEmail';
import KenyanComplianceBriefEmail from '@/emails/templates/marketing/KenyanComplianceBriefEmail';

// ---------------------------------------------------------------------------
// Per-template Zod schemas (validate admin-supplied templateVariables only)
// ---------------------------------------------------------------------------

const PilotInvitationVarsSchema = z.object({
  recipientCompanyName: z.string().optional(),
  applicationUrl:       z.string().url(),
  expiresInDays:        z.number().int().min(1).max(90).default(14),
  inviterName:          z.string().optional(),
});

const RegulatorAccessProgramVarsSchema = z.object({
  regulatorName: z.string().min(1),
  signupUrl:     z.string().url(),
});

const ProductLaunchVarsSchema = z.object({
  featureName:    z.string().min(1),
  featureTagline: z.string().min(1),
  ctaUrl:         z.string().url(),
  ctaText:        z.string().min(1),
  whatsNew:       z.array(z.string()).min(1).max(10),
});

const ComplianceUpdateVarsSchema = z.object({
  updateTitle:    z.string().min(1),
  regulatorName:  z.string().min(1),
  publishedDate:  z.string().min(1),
  summary:        z.string().min(1),
  whoAffected:    z.string().min(1),
  ctaUrl:         z.string().url(),
});

const WebinarInviteVarsSchema = z.object({
  eventTitle:       z.string().min(1),
  eventDate:        z.string().min(1),
  eventTime:        z.string().min(1),
  eventLocation:    z.string().min(1),
  speakerNames:     z.array(z.string()).min(0).max(10),
  agenda:           z.array(z.string()).min(0).max(10),
  registrationUrl:  z.string().url(),
});

const ResourceDownloadVarsSchema = z.object({
  resourceTitle:       z.string().min(1),
  resourceDescription: z.string().min(1),
  downloadUrl:         z.string().url(),
  pageCount:           z.number().int().positive().optional(),
  fileFormat:          z.string().optional(),
});

const GenericMarketingVarsSchema = z.object({
  headline:        z.string().min(1),
  bodyParagraphs:  z.array(z.string()).min(1).max(20),
  ctaUrl:          z.string().url().optional(),
  ctaText:         z.string().optional(),
});

const KenyanComplianceBriefVarsSchema = z.object({
  editionLabel: z.string().min(1),
  intro:        z.string().optional(),
  items: z.array(z.object({
    title:     z.string().min(1),
    summary:   z.string().min(1),
    sourceUrl: z.string().url().optional(),
  })).min(1).max(10),
});

// ---------------------------------------------------------------------------
// Registry entry type
// ---------------------------------------------------------------------------

export interface TemplateRegistryEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: React.ComponentType<any>;
  validateVars: (vars: unknown) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TEMPLATE_REGISTRY: Record<MarketingTemplateKey, TemplateRegistryEntry> = {
  [MarketingTemplateKey.PILOT_INVITATION]: {
    component:    PilotInvitationEmail,
    validateVars: (vars) => PilotInvitationVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.REGULATOR_ACCESS_PROGRAM]: {
    component:    RegulatorAccessProgramEmail,
    validateVars: (vars) => RegulatorAccessProgramVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.PRODUCT_LAUNCH]: {
    component:    ProductLaunchEmail,
    validateVars: (vars) => ProductLaunchVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.COMPLIANCE_UPDATE]: {
    component:    ComplianceUpdateEmail,
    validateVars: (vars) => ComplianceUpdateVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.WEBINAR_INVITE]: {
    component:    WebinarInviteEmail,
    validateVars: (vars) => WebinarInviteVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.RESOURCE_DOWNLOAD]: {
    component:    ResourceDownloadEmail,
    validateVars: (vars) => ResourceDownloadVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.GENERIC_MARKETING]: {
    component:    GenericMarketingEmail,
    validateVars: (vars) => GenericMarketingVarsSchema.parse(vars) as Record<string, unknown>,
  },
  [MarketingTemplateKey.KENYAN_COMPLIANCE_BRIEF]: {
    component:    KenyanComplianceBriefEmail,
    validateVars: (vars) => KenyanComplianceBriefVarsSchema.parse(vars) as Record<string, unknown>,
  },
};

-- Phase B Batch 1 (templated sendNewsletter): adds the one new MarketingTemplateKey
-- value the new "Kenyan Compliance Brief" digest template needs. Additive only -
-- no table/column changes. Apply manually (per this project's convention - no
-- `prisma migrate`), then run `prisma generate` to sync the client.
--
-- Safe by construction: existing MarketingCampaign rows are unaffected (none of
-- them reference this value yet), and adding an enum value is non-breaking for
-- every existing reader of MarketingTemplateKey.

ALTER TYPE "MarketingTemplateKey" ADD VALUE IF NOT EXISTS 'KENYAN_COMPLIANCE_BRIEF';

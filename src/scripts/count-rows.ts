import 'dotenv/config';
import { prisma } from '../lib/prisma/client';
import { Prisma } from '@prisma/client';

async function main() {
  const tables = [
    'Company', 'Contact', 'ContactList', 'ContactListMembership', 'MarketingCampaign', 'CampaignSend', 'SuppressionList', 'EmailEvent', 'ConsentRecord', 'CampaignSendJob', 'BlogPost', 'BlogPostSource', 'BlogSourceMonitor', 'BlogSourceItem', 'BlogDiscoveryRun', 'BlogVerificationRun', 'BlogVerificationIssue', 'BlogArticleSuggestion', 'BlogSuggestionSource', 'AgentRun', 'AgentReport', 'MarketingDraft', 'RegulatorySignal', 'SalesOutreachDraft', 'BlogDraftGenerationRun', 'BlogEditorialDigest', 'AutomationApproval'
  ];
  
  console.log("Table\tExists before migration\tRow count before");
  for (const table of tables) {
    try {
      const result: any = await prisma.$queryRaw(Prisma.raw(`SELECT count(*) as cnt FROM "${table}"`));
      const count = Number(result[0].cnt);
      console.log(`${table}\tYES\t${count}`);
    } catch (e: any) {
      if (e.message.includes('does not exist')) {
        console.log(`${table}\tNO\tN/A`);
      } else {
        console.log(`${table}\tYES\tERROR: ${e.message}`);
      }
    }
  }
}

main().catch(console.error);

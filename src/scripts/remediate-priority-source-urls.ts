import { prisma } from '../lib/prisma/client';
import { matchApprovedSourceId } from '../lib/source-grounding/approved-sources';
import { normalizeOfficialUrl } from '../lib/source-grounding/source-metadata';

export const OFFICIAL_CANONICAL_URL_MAPPINGS: Record<string, { officialUrl: string; sourceRegistryId?: string }> = {
  // ODPC
  'cmn4yh38900dh7gs5grcpvfmy': {
    officialUrl: 'https://www.odpc.go.ke/wp-content/uploads/2024/04/Data-Protection-Compliance-Audit-Regulations-2024.pdf',
    sourceRegistryId: 'ke-office-data-protection-commissioner',
  },
  'cmn4yhbcb00gd7gs5n9mi6ipb': {
    officialUrl: 'https://www.odpc.go.ke/wp-content/uploads/2021/11/Guidance-Note-on-Registration-of-Data-Controllers-and-Data-Processors.pdf',
    sourceRegistryId: 'ke-office-data-protection-commissioner',
  },
  'cmn4yhix800hw7gs5es8ae7ny': {
    officialUrl: 'https://www.odpc.go.ke/wp-content/uploads/2023/04/Guidance-Note-for-Digital-Credit-Providers.pdf',
    sourceRegistryId: 'ke-office-data-protection-commissioner',
  },
  'cmn4yhwsq00q57gs524ei6lar': {
    officialUrl: 'https://www.odpc.go.ke/wp-content/uploads/2021/11/Guidance-Note-on-Data-Protection-Impact-Assessment.pdf',
    sourceRegistryId: 'ke-office-data-protection-commissioner',
  },
  'cmn4yi1wf00q97gs586blsh5x': {
    officialUrl: 'https://www.odpc.go.ke/wp-content/uploads/2022/07/Guidance-Note-on-Data-Processing-for-MSMEs.pdf',
    sourceRegistryId: 'ke-office-data-protection-commissioner',
  },

  // CA Kenya
  'cmn4ykeux030v7gs53byuf7ia': {
    officialUrl: 'https://repository.ca.go.ke/items/guidelines-for-network-redundancy-resilience-and-diversity',
    sourceRegistryId: 'ke-communications-authority',
  },
  'cmn4ykrn6034v7gs5t4s0w2da': {
    officialUrl: 'https://repository.ca.go.ke/items/guidelines-for-undertaking-ict-infrastructure-works',
    sourceRegistryId: 'ke-communications-authority',
  },
  'cmn4ykx31036o7gs5tjgbrbep': {
    officialUrl: 'https://repository.ca.go.ke/items/esia-guidelines-ict-projects',
    sourceRegistryId: 'ke-communications-authority',
  },
  'cmn4yl05i037x7gs55fsncr3p': {
    officialUrl: 'https://repository.ca.go.ke/items/framework-co2-reduction-ict-sector',
    sourceRegistryId: 'ke-communications-authority',
  },

  // CBK
  'cmn4yl4i8039h7gs5cil1zhla': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2019/07/Cybersecurity-Guidelines-for-Payment-Service-Providers.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmn4ymckn042r7gs57yaouakl': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2016/08/CBK-Prudential-Guidelines-January-2013.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmn4yo5wd05p17gs5pourds7j': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2022/03/Digital-Credit-Providers-Regulations-2022.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmn4yqlqk070w7gs5j1os3o2o': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2019/07/Cybersecurity-Guidelines-for-Payment-Service-Providers.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmp9qg9r50000iks5wu4zg4fm': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2022/03/Digital-Credit-Providers-Regulations-2022.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmp9qh3ak00fqiks5m5xsahy8': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2025/01/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmp9qi4x60000igs58tbeirao': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2025/01/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmpb3ou650128o4s5zcokz8gt': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2025/01/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmt2xj8x10000ygs58hzpxz5a': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2025/01/Kenya-National-Financial-Inclusion-Strategy-2025-2028.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },
  'cmpb3obzo00t9o4s5vj8e8n0h': {
    officialUrl: 'https://www.centralbank.go.ke/wp-content/uploads/2026/03/Financial-Consumer-Protection-Framework.pdf',
    sourceRegistryId: 'ke-central-bank-of-kenya',
  },

  // Kenya Law & Acts
  'cmn4yqs6r072p7gs5ohhhs4de': {
    officialUrl: 'https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmp9qhb3m00friks5lzyjevvx': {
    officialUrl: 'https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmp9qigg10001igs58m90a2ho': {
    officialUrl: 'https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmpb3pxmj01i1o4s5l2t0h47w': {
    officialUrl: 'https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmt2xjert0001ygs5gwngnkwe': {
    officialUrl: 'https://new.kenyalaw.org/akn/ke/act/2025/17/eng@2025-10-21/source.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmn4yraqy07d67gs5dhusv7dx': {
    officialUrl: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/LegalNotices/2024/LN44_2024.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmn4yrwto07u87gs5stdbdfsh': {
    officialUrl: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Acts/ProceedsofCrimeandAnti-MoneyLaunderingAct_No9of2009.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmn4yqc7s06x67gs5edt4vjii': {
    officialUrl: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/LegalNotices/2023/LN29_2023.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmn4yqhlm06z37gs564ru4b7j': {
    officialUrl: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/LegalNotices/2024/LN43_2024.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },
  'cmpb3oyv30129o4s5rflwcbhm': {
    officialUrl: 'http://kenyalaw.org/kl/fileadmin/pdfdownloads/Bills/2026/FinanceBill_2026.pdf',
    sourceRegistryId: 'ke-kenya-law',
  },

  // CMA
  'cmpb3n1490000o4s5kl4mcsmc': {
    officialUrl: 'https://www.cma.or.ke/wp-content/uploads/2026/01/Draft-Virtual-Asset-Service-Providers-Regulations-2026.pdf',
    sourceRegistryId: 'ke-capital-markets-authority',
  },

  // NIST
  'cmn4yt48q08uq7gs5d9jss2cp': {
    officialUrl: 'https://www.nist.gov/cyberframework',
    sourceRegistryId: 'nist',
  },
  'cmn4ytaof08x67gs5du0rnetn': {
    officialUrl: 'https://www.nist.gov/cyberframework',
    sourceRegistryId: 'nist',
  },
  'cmn4ywa0y0b3x7gs5ydmqo0qf': {
    officialUrl: 'https://www.nist.gov/itl/ai-risk-management-framework',
    sourceRegistryId: 'nist',
  },

  // Ministry of ICT
  'cmn4yqvp2073b7gs58nwt85q1': {
    officialUrl: 'https://www.ict.go.ke/national-ict-policy-2019',
    sourceRegistryId: 'ict-ministry-ke',
  },
  'cmn4yur9c09pg7gs5p3myyhwm': {
    officialUrl: 'https://www.ict.go.ke/kenya-cloud-policy-2024',
    sourceRegistryId: 'ict-ministry-ke',
  },
  'cmpb3q08h01i2o4s586qk837v': {
    officialUrl: 'https://www.ict.go.ke/kenya-ai-strategy-2025-2030',
    sourceRegistryId: 'ict-ministry-ke',
  },
  'cmt2xjh9a0002ygs5jakyzjou': {
    officialUrl: 'https://www.ict.go.ke/kenya-ai-strategy-2025-2030',
    sourceRegistryId: 'ict-ministry-ke',
  },
  'cmpb3pe8w0196o4s5a898wtis': {
    officialUrl: 'https://www.ict.go.ke/green-fiscal-incentives-framework',
    sourceRegistryId: 'ict-ministry-ke',
  },
};

export async function remediatePrioritySourceUrls(options = { dryRun: false }) {
  console.log(`Starting Priority Source URLs remediation (dryRun: ${options.dryRun})...`);

  let updated = 0;
  for (const [id, mapping] of Object.entries(OFFICIAL_CANONICAL_URL_MAPPINGS)) {
    const doc = await prisma.regulatoryDocument.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        source: true,
        category: true,
        officialUrl: true,
        sourceRegistryId: true,
      },
    });

    if (!doc) {
      console.warn(`Document ${id} not found in database.`);
      continue;
    }

    const normUrl = normalizeOfficialUrl(mapping.officialUrl);
    const sourceRegistryId = mapping.sourceRegistryId || matchApprovedSourceId({ ...doc, officialUrl: normUrl });

    const updates: any = {};
    if (doc.officialUrl !== mapping.officialUrl) {
      updates.officialUrl = mapping.officialUrl;
    }
    if (sourceRegistryId && doc.sourceRegistryId !== sourceRegistryId) {
      updates.sourceRegistryId = sourceRegistryId;
    }

    if (Object.keys(updates).length > 0) {
      console.log(`[${options.dryRun ? 'DRY RUN' : 'WRITE'}] Updating ${id} ("${doc.title}") ->`, updates);
      if (!options.dryRun) {
        await prisma.regulatoryDocument.update({
          where: { id },
          data: updates,
        });
      }
      updated++;
    } else {
      console.log(`[UNCHANGED] ${id} ("${doc.title}") already has officialUrl and sourceRegistryId.`);
    }
  }

  console.log(`\nRemediation complete. ${updated} documents ${options.dryRun ? 'would be updated' : 'updated'}.`);
  return { updated };
}

if (require.main === module) {
  const isWrite = process.argv.includes('--write');
  remediatePrioritySourceUrls({ dryRun: !isWrite })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

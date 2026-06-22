import 'dotenv/config';
import { PrismaClient, BlogJurisdiction, BlogAuthorityType, BlogSourceType, BlogMonitoringMethod, BlogMonitorStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! } as any);
const prisma = new PrismaClient({ adapter } as never);

const monitors = [
  // Kenya
  {
    name: 'Central Bank of Kenya (CBK)',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'CENTRAL_BANK' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.centralbank.go.ke',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Office of the Data Protection Commissioner (ODPC)',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'DATA_PROTECTION' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.odpc.go.ke',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Financial Reporting Centre (FRC)',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'AML_CFT' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.frc.go.ke',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Capital Markets Authority (CMA)',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'SECURITIES' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.cma.or.ke',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Communications Authority (CA)',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'COMMUNICATIONS' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.ca.go.ke',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Kenya Law',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'LEGAL_DATABASE' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'http://kenyalaw.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Kenya Gazette',
    jurisdiction: 'KE' as BlogJurisdiction,
    authorityType: 'GAZETTE' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'http://kenyalaw.org/kenya_gazette',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },

  // Malawi
  {
    name: 'Reserve Bank of Malawi (RBM)',
    jurisdiction: 'MW' as BlogJurisdiction,
    authorityType: 'CENTRAL_BANK' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.rbm.mw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Malawi Communications Regulatory Authority (MACRA)',
    jurisdiction: 'MW' as BlogJurisdiction,
    authorityType: 'COMMUNICATIONS' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://macra.mw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Financial Intelligence Authority (FIA)',
    jurisdiction: 'MW' as BlogJurisdiction,
    authorityType: 'AML_CFT' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.fia.gov.mw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Malawi Legal Source / Gazette',
    jurisdiction: 'MW' as BlogJurisdiction,
    authorityType: 'GAZETTE' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://example.com/mw-gazette', // placeholder
    status: 'NEEDS_VERIFICATION' as BlogMonitorStatus,
    verificationStatus: 'NEEDS_VERIFICATION',
    isActive: false,
  },
  {
    name: 'Malawi Data Protection/Privacy',
    jurisdiction: 'MW' as BlogJurisdiction,
    authorityType: 'DATA_PROTECTION' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://example.com/mw-dp', // placeholder
    status: 'NEEDS_VERIFICATION' as BlogMonitorStatus,
    verificationStatus: 'NEEDS_VERIFICATION',
    isActive: false,
  },

  // Rwanda
  {
    name: 'National Bank of Rwanda (BNR)',
    jurisdiction: 'RW' as BlogJurisdiction,
    authorityType: 'CENTRAL_BANK' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.bnr.rw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Rwanda Utilities Regulatory Authority (RURA)',
    jurisdiction: 'RW' as BlogJurisdiction,
    authorityType: 'COMMUNICATIONS' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://rura.rw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Rwanda Information Society Authority (RISA)',
    jurisdiction: 'RW' as BlogJurisdiction,
    authorityType: 'COMMUNICATIONS' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.risa.rw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Data Protection and Privacy Office (DPPO)',
    jurisdiction: 'RW' as BlogJurisdiction,
    authorityType: 'DATA_PROTECTION' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://dppo.gov.rw',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Rwanda Official Gazette',
    jurisdiction: 'RW' as BlogJurisdiction,
    authorityType: 'GAZETTE' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://example.com/rw-gazette',
    status: 'NEEDS_VERIFICATION' as BlogMonitorStatus,
    verificationStatus: 'NEEDS_VERIFICATION',
    isActive: false,
  },

  // Nigeria
  {
    name: 'Central Bank of Nigeria (CBN)',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'CENTRAL_BANK' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.cbn.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Nigeria Data Protection Commission (NDPC)',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'DATA_PROTECTION' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://ndpc.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Securities and Exchange Commission (SEC)',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'SECURITIES' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://sec.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Nigerian Communications Commission (NCC)',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'COMMUNICATIONS' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://ncc.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Nigerian Financial Intelligence Unit (NFIU)',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'AML_CFT' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.nfiu.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Federal Competition and Consumer Protection',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'CONSUMER_PROTECTION' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://fccpc.gov.ng',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'Nigeria Official Legal/Gazette',
    jurisdiction: 'NG' as BlogJurisdiction,
    authorityType: 'GAZETTE' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://example.com/ng-gazette',
    status: 'NEEDS_VERIFICATION' as BlogMonitorStatus,
    verificationStatus: 'NEEDS_VERIFICATION',
    isActive: false,
  },

  // Regional & Global
  {
    name: 'FATF',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'INTERNATIONAL_STANDARD' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.fatf-gafi.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'BIS',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'INTERNATIONAL_STANDARD' as BlogAuthorityType,
    sourceType: 'OFFICIAL' as BlogSourceType,
    monitoringMethod: 'HTML_LISTING' as BlogMonitoringMethod,
    baseUrl: 'https://www.bis.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'World Bank',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'DEVELOPMENT_FINANCE' as BlogAuthorityType,
    sourceType: 'THIRD_PARTY' as BlogSourceType,
    monitoringMethod: 'API' as BlogMonitoringMethod,
    baseUrl: 'https://www.worldbank.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'IMF',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'DEVELOPMENT_FINANCE' as BlogAuthorityType,
    sourceType: 'THIRD_PARTY' as BlogSourceType,
    monitoringMethod: 'RSS' as BlogMonitoringMethod,
    baseUrl: 'https://www.imf.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'AFI',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'INDUSTRY_BODY' as BlogAuthorityType,
    sourceType: 'THIRD_PARTY' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.afi-global.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'GSMA',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'INDUSTRY_BODY' as BlogAuthorityType,
    sourceType: 'THIRD_PARTY' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.gsma.com',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
  {
    name: 'ISO',
    jurisdiction: 'GLOBAL' as BlogJurisdiction,
    authorityType: 'INTERNATIONAL_STANDARD' as BlogAuthorityType,
    sourceType: 'THIRD_PARTY' as BlogSourceType,
    monitoringMethod: 'MANUAL' as BlogMonitoringMethod,
    baseUrl: 'https://www.iso.org',
    status: 'ACTIVE' as BlogMonitorStatus,
    verificationStatus: 'VERIFIED',
    isActive: true,
  },
];

async function main() {
  console.log('Seeding Blog Source Monitors...');
  for (const monitor of monitors) {
    const existing = await prisma.blogSourceMonitor.findFirst({
      where: {
        name: monitor.name,
      },
    });

    if (existing) {
      console.log(`Skipping existing: ${monitor.name}`);
      continue;
    }

    await prisma.blogSourceMonitor.create({
      data: monitor,
    });
    console.log(`Created: ${monitor.name}`);
  }
  console.log('Finished seeding Blog Source Monitors.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

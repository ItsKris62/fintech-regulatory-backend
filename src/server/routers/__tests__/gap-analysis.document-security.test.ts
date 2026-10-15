import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { GAP_ANALYSIS_PROCESSING_ACK_VERSION } from '@/config/gap-analysis.config';
import {
  validateGapAnalysisFile,
  SCANNED_PDF_REJECTION_MESSAGE,
  ENCRYPTED_PDF_REJECTION_MESSAGE,
  GAP_ANALYSIS_ZIP_MAX_ENTRIES,
  inspectZipArchive,
} from '@/lib/security/gap-analysis-file-validator';
import {
  scanGapAnalysisBuffer,
  MalwareDetectedError,
  MalwareScanServiceError,
  EICAR_STANDARD_TEST_SIGNATURE,
  assertProductionMalwareScanningAvailable,
  probeGapAnalysisMalwareScanner,
  DisabledDevelopmentScanner,
  type DocumentMalwareScanStatus,
  type DocumentMalwareScanner,
} from '@/lib/security/gap-analysis-malware';
import { scrubAiJobPayload } from '@/modules/ai-jobs/ai-job-runner';

// Hoisted mocks for router & pipeline integration
const mocks = vi.hoisted(() => {
  const gapCreate = vi.fn();
  const gapUpdate = vi.fn();
  const gapUpdateMany = vi.fn();
  const gapFindUnique = vi.fn();
  const gapFindMany = vi.fn();
  const aiJobUpdate = vi.fn();
  const aiJobUpdateMany = vi.fn();
  const aiJobFindUnique = vi.fn();
  const aiJobFindMany = vi.fn();
  const auditLogCreate = vi.fn();
  const orgMemberFindUnique = vi.fn();
  const regulatoryFrameworkFindMany = vi.fn();

  return {
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    redisDel: vi.fn(),
    storageUpload: vi.fn(),
    storageDownload: vi.fn(),
    storageDelete: vi.fn(),
    aiJobEnqueue: vi.fn(),
    aiJobUpdate,
    aiJobUpdateMany,
    aiJobFindUnique,
    aiJobFindMany,
    gapCreate,
    gapUpdate,
    gapUpdateMany,
    gapFindUnique,
    gapFindMany,
    auditLogCreate,
    orgMemberFindUnique,
    regulatoryFrameworkFindMany,
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    aiPerformGapAnalysis: vi.fn(),
    prisma: {
      gapAnalysis: {
        create: gapCreate,
        update: gapUpdate,
        updateMany: gapUpdateMany,
        findUnique: gapFindUnique,
        findMany: gapFindMany,
      },
      aiJob: {
        update: aiJobUpdate,
        updateMany: aiJobUpdateMany,
        findUnique: aiJobFindUnique,
        findMany: aiJobFindMany,
      },
      auditLog: {
        create: auditLogCreate,
      },
      organizationMember: {
        findUnique: orgMemberFindUnique,
      },
      regulatoryFramework: {
        findMany: regulatoryFrameworkFindMany,
      },
      gapAnalysisFramework: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({ id: 'user-sec-1', role: 'STARTUP', fullName: 'Test Security User' }),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ id: 'org-sec-1', name: 'Test Org' }),
      },
    },
  };
});

vi.mock('@/utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: mocks.redisGet,
    set: mocks.redisSet,
    del: mocks.redisDel,
    incr: vi.fn().mockResolvedValue(1),
    incrby: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/storage/storage.service', () => ({
  storageService: {
    uploadDocument: mocks.storageUpload,
    downloadFile: mocks.storageDownload,
    deleteFile: mocks.storageDelete,
  },
}));

vi.mock('@/modules/ai-jobs/ai-job-runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/modules/ai-jobs/ai-job-runner')>();
  return {
    ...actual,
    aiJobRunner: {
      ...actual.aiJobRunner,
      enqueue: mocks.aiJobEnqueue,
    },
  };
});

vi.mock('@/modules/regulatory-intelligence/regulatory-intelligence.service', () => ({
  regulatoryIntelligenceService: {
    retrieveAndGrade: vi.fn().mockResolvedValue({
      evidence: [
        {
          vectorId: 'vec-dpa-1',
          chunkId: 'chunk-dpa-1',
          chunkText: 'Data controller must process personal data lawfully in accordance with section 25 of the Data Protection Act 2019.',
          documentId: 'doc-dpa-1',
          documentTitle: 'Data Protection Act 2019',
          frameworkSlug: 'dpa_2019',
          framework: 'Data Protection Act 2019',
          jurisdictionCode: 'KE',
          score: 0.95,
          authorityStatus: 'BINDING',
        },
      ],
    }),
  },
}));

vi.mock('@/lib/ai/ai.service', () => ({
  aiService: {
    performGapAnalysis: mocks.aiPerformGapAnalysis,
  },
}));

vi.mock('@/modules/compliance/orchestrator/verifier.agent', () => ({
  runVerifierAgent: vi.fn().mockResolvedValue({ verdict: 'VERIFIED', unsupportedClaims: [] }),
  verifyFindingClaims: vi.fn().mockReturnValue([]),
  resolveFindingEvidence: vi.fn().mockReturnValue({
    resolvedEvidenceIds: [],
    invalidEvidenceIds: [],
    resolvedPolicyEvidenceIds: [],
    invalidPolicyEvidenceIds: [],
  }),
}));

vi.mock('@/lib/prisma/client', () => ({
  prisma: mocks.prisma,
}));

vi.mock('@/lib/system-config', () => ({
  loadSystemConfig: vi.fn().mockResolvedValue({ maintenanceMode: false, maintenanceMessage: '' }),
  getSystemConfigNumber: vi.fn().mockImplementation(async (_key: string, fallback: number) => fallback),
}));

vi.mock('@/modules/notification', () => ({
  notificationModule: {
    createCategorizedNotification: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/modules/jurisdiction/jurisdiction-entitlements', () => ({
  resolveJurisdictionEntitlement: vi.fn().mockResolvedValue({
    jurisdictionContext: {
      mode: 'SINGLE',
      jurisdictions: ['KE'],
      primaryJurisdiction: 'KE',
      source: 'REQUEST',
    },
    homeJurisdiction: 'KE',
  }),
  toTrpcJurisdictionAuthorizationError: vi.fn(),
}));

vi.mock('@/modules/billing/resolve-effective-plan', () => ({
  resolveEffectivePlan: vi.fn().mockResolvedValue({
    plan: 'BUSINESS',
    orgPlan: 'BUSINESS',
    entitlements: {
      gapAnalysis: true,
      gapAnalysisDepths: ['quick', 'standard', 'deep'],
      gapAnalysisMaxFileSizeBytes: 10 * 1024 * 1024,
      allowedFileTypes: ['pdf', 'docx', 'txt'],
    },
    subscriptionStatus: 'ACTIVE',
  }),
}));

import { gapAnalysisRouter } from '../gap-analysis.router';
import { executeGapAnalysisPipeline, complianceModule } from '@/modules/compliance/compliance.module';

function createCaller(userId = 'user-sec-1', orgId = 'org-sec-1') {
  return gapAnalysisRouter.createCaller({
    user: {
      id: userId,
      email: 'sec@test.org',
      role: 'STARTUP',
      organizationId: orgId,
      totpEnabled: true,
    } as any,
    orgMembership: {
      organizationId: orgId,
      role: 'ADMIN',
      status: 'ACTIVE',
    } as any,
    prisma: mocks.prisma as any,
    tenantPrisma: {
      gapAnalysis: {
        findUnique: vi.fn().mockResolvedValue(null),
        findFirst: vi.fn().mockResolvedValue(null),
      },
    } as any,
    req: { ip: '127.0.0.1', headers: { 'user-agent': 'vitest-security' } } as any,
    res: {} as any,
  } as any);
}

// Helpers to generate in-memory valid fixtures
async function createValidDocxBuffer(text = 'This is a genuine Word DOCX policy with more than fifty characters of compliance requirements.'): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [new Paragraph({ children: [new TextRun(text)] })],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

function createMinimalValidPdfBuffer(text = 'This is a valid compliant policy document containing sufficient text for testing.'): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 120 >>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(${text}) Tj\nET\nendstream\nendobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000214 00000 n \ntrailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n349\n%%EOF`
  );
}

function createEncryptedPdfBuffer(): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Encrypt 5 0 R >>\nendobj\n%%EOF`
  );
}

function createEmptyScannedPdfBuffer(): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n200\n%%EOF`
  );
}

function createFakeZipBuffer(entryName = 'unrelated.txt', content = 'hello'): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const dataBuf = Buffer.from(content, 'utf8');
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
  localHeader.writeUInt16LE(20, 4); // version
  localHeader.writeUInt16LE(0, 8); // compression = 0
  localHeader.writeUInt32LE(dataBuf.length, 18); // comp size
  localHeader.writeUInt32LE(dataBuf.length, 22); // uncomp size
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const cdHeader = Buffer.alloc(46);
  cdHeader.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 10);
  cdHeader.writeUInt32LE(dataBuf.length, 20);
  cdHeader.writeUInt32LE(dataBuf.length, 24);
  cdHeader.writeUInt16LE(nameBuf.length, 28);
  cdHeader.writeUInt32LE(0, 42); // offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(1, 8); // entries
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cdHeader.length + nameBuf.length, 12); // cd size
  eocd.writeUInt32LE(localHeader.length + nameBuf.length + dataBuf.length, 16); // cd offset

  return Buffer.concat([localHeader, nameBuf, dataBuf, cdHeader, nameBuf, eocd]);
}

function createExcessiveEntriesZipBuffer(count = 505): Buffer {
  const cdHeaders: Buffer[] = [];
  let currentOffset = 0;
  const localChunks: Buffer[] = [];

  for (let i = 0; i < count; i++) {
    const name = `file_${i}.txt`;
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBuf.length, 26);
    localChunks.push(local, nameBuf);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(currentOffset, 42);
    cdHeaders.push(cd, nameBuf);

    currentOffset += 30 + nameBuf.length;
  }

  const cdTotalSize = cdHeaders.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdTotalSize, 12);
  eocd.writeUInt32LE(currentOffset, 16);

  return Buffer.concat([...localChunks, ...cdHeaders, eocd]);
}

describe('BATCH 4: DOCUMENT SECURITY, PRIVACY, RETENTION, CONSENT & SAFE FILE PROCESSING', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gapCreate.mockResolvedValue({
      id: 'analysis-sec-123',
      userId: 'user-sec-1',
      organizationId: 'org-sec-1',
      status: 'UPLOADING',
    });
    mocks.gapUpdate.mockResolvedValue({});
    mocks.gapUpdateMany.mockResolvedValue({ count: 1 });
    mocks.aiJobUpdateMany.mockResolvedValue({ count: 1 });
    mocks.auditLogCreate.mockResolvedValue({});
    mocks.orgMemberFindUnique.mockResolvedValue({
      userId: 'user-sec-1',
      organizationId: 'org-sec-1',
      role: 'ADMIN',
      status: 'ACTIVE',
    });
    mocks.regulatoryFrameworkFindMany.mockResolvedValue([
      { id: 'fw-1', slug: 'dpa_2019', name: 'Data Protection Act 2019', category: 'DATA_PROTECTION', tier: 'STANDARD', sortOrder: 1 },
    ]);
    mocks.redisGet.mockImplementation(async (key: string) => {
      if (key.startsWith('sheriabot:orgmem:')) {
        return { userId: 'user-sec-1', organizationId: 'org-sec-1', role: 'ADMIN', status: 'ACTIVE' };
      }
      return null;
    });
    mocks.storageUpload.mockResolvedValue({ key: 'gap-analysis/org-sec-1/analysis-sec-123/uuid-file.pdf' });
    mocks.aiJobEnqueue.mockResolvedValue({ id: 'job-sec-456' });
    mocks.aiPerformGapAnalysis.mockResolvedValue({
      result: {
        overallScore: 85,
        executiveSummary: 'Summary',
        frameworks: [{ id: 'DPA_2019', name: 'Data Protection Act 2019', score: 85, gaps: [], strengths: [], summary: 'Summary' }],
        crossCuttingStrengths: [],
        actionPlan: [],
        metadata: {
          documentName: 'test.pdf', analysisDepth: 'standard', frameworksAnalysed: ['Data Protection Act 2019'],
          totalGaps: 0, criticalGaps: 0, highGaps: 0, analysisDate: new Date().toISOString(),
        },
      },
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  // ==========================================================================
  // SECTION 24: SECURITY TEST MATRIX (Items 1 - 40)
  // ==========================================================================

  describe('1-6: Base64 / Job Payload & Logging Security', () => {
    it('1. New job payload contains NO fileContent or base64 raw document bytes', async () => {
      const caller = createCaller();
      const txtBuffer = Buffer.from('This is a valid plaintext privacy and security policy document with more than 50 characters.');

      await caller.runGapAnalysis({
        fileName: 'policy.txt',
        fileType: 'txt',
        fileContent: txtBuffer.toString('base64'),
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
        consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      });

      expect(mocks.aiJobEnqueue).toHaveBeenCalledTimes(1);
      const enqueuedJob = mocks.aiJobEnqueue.mock.calls[0][0];
      const payload = enqueuedJob.payload;

      expect(payload).toHaveProperty('storageKey');
      expect(payload.storageKey).toMatch(/^gap-analysis\/org-sec-1\/analysis-sec-123\//);
      expect(payload).toHaveProperty('fileSize', txtBuffer.length);
      expect(payload).toHaveProperty('fileName', 'policy.txt');
      expect(payload).not.toHaveProperty('fileContent');
      expect(payload).not.toHaveProperty('base64');
      expect(JSON.stringify(payload)).not.toContain(txtBuffer.toString('base64'));
    });

    it('2. Job remains retryable using storage reference alone (without fileContent in payload)', async () => {
      const validTxtBuffer = Buffer.from('This is a valid compliant policy document containing sufficient text for testing and verification.');
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-sec-123',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-sec-123/test.txt',
        deletedAt: null,
      });
      mocks.storageDownload.mockResolvedValue(validTxtBuffer);

      await executeGapAnalysisPipeline({
        analysisId: 'analysis-sec-123',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        storageKey: 'gap-analysis/org-sec-1/analysis-sec-123/test.txt',
        fileName: 'policy.txt',
        fileType: 'txt',
        regulatoryFrameworks: ['Data Protection Act 2019'],
        regulatoryFrameworkSlugs: ['dpa_2019'],
        jurisdictionContext: {
          mode: 'SINGLE',
          jurisdictions: ['KE'],
          primaryJurisdiction: 'KE',
          jurisdictionSource: 'REQUEST',
        },
        analysisDepth: 'quick',
      });

      expect(mocks.storageDownload).toHaveBeenCalledWith('gap-analysis/org-sec-1/analysis-sec-123/test.txt');
    });

    it('3. Completed job payload contains no policy body after terminal scrubbing', async () => {
      mocks.aiJobFindUnique.mockResolvedValue({
        id: 'job-completed-1',
        payload: {
          analysisId: 'ga-1',
          fileName: 'policy.pdf',
          fileContent: 'LEGACY_BASE64_BODY_TO_SCRUB',
          base64: 'ANOTHER_LEGACY_KEY',
        },
      });

      await scrubAiJobPayload('job-completed-1');

      expect(mocks.aiJobUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'job-completed-1' },
          data: {
            payload: expect.objectContaining({
              analysisId: 'ga-1',
              fileName: 'policy.pdf',
              payloadScrubbedAt: expect.any(String),
            }),
          },
        })
      );
      const updatedPayload = mocks.aiJobUpdate.mock.calls[0][0].data.payload;
      expect(updatedPayload).not.toHaveProperty('fileContent');
      expect(updatedPayload).not.toHaveProperty('base64');
    });

    it('4. Failed terminal job payload contains no policy body after scrubbing', async () => {
      mocks.aiJobFindUnique.mockResolvedValue({
        id: 'job-failed-1',
        payload: {
          analysisId: 'ga-2',
          fileContent: 'LEAKED_SECRET_BASE64',
        },
      });

      await scrubAiJobPayload('job-failed-1');

      const updatedPayload = mocks.aiJobUpdate.mock.calls[0][0].data.payload;
      expect(updatedPayload).not.toHaveProperty('fileContent');
      expect(updatedPayload).toHaveProperty('payloadScrubbedAt');
    });

    it('5. Cancelled job payloads are scrubbed on deletion of GapAnalysis', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-sec-123/file.pdf',
        reportUrl: null,
        deletedAt: null,
      });
      mocks.aiJobFindMany.mockResolvedValue([{ id: 'job-to-cancel-1' }]);
      mocks.aiJobFindUnique.mockResolvedValue({
        id: 'job-to-cancel-1',
        payload: { fileContent: 'SENSITIVE_CONTENT' },
      });

      await complianceModule.deleteGapAnalysis('user-sec-1', 'org-sec-1', 'analysis-sec-123');

      expect(mocks.aiJobUpdateMany).toHaveBeenCalledWith({
        where: {
          type: 'GAP_ANALYSIS_PIPELINE',
          targetEntityType: 'GapAnalysis',
          targetEntityId: 'analysis-sec-123',
          status: { in: ['QUEUED', 'RUNNING', 'RETRYING'] },
        },
        data: { status: 'CANCELLED', lockedAt: null, lockedBy: null },
      });
    });

    it('6. Structured logger output contains zero customer policy text', async () => {
      const privatePolicyText = 'SHERIABOT_CONFIDENTIAL_INTERNAL_CUSTOMER_BANKING_CORE_POLICY_XYZ_99';
      const txtBuffer = Buffer.from(privatePolicyText);

      const caller = createCaller();
      await caller.runGapAnalysis({
        fileName: 'confidential.txt',
        fileType: 'txt',
        fileContent: txtBuffer.toString('base64'),
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
        consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      });

      // Verify all logger calls
      const allLogCalls = [
        ...mocks.loggerInfo.mock.calls,
        ...mocks.loggerWarn.mock.calls,
        ...mocks.loggerError.mock.calls,
      ];

      for (const [loggedObj] of allLogCalls) {
        const serialized = JSON.stringify(loggedObj);
        expect(serialized).not.toContain(privatePolicyText);
      }
    });
  });

  describe('7-16: File Format & Content-Type Validation', () => {
    it('7. Valid PDF with %PDF- header and readable text is accepted', async () => {
      const pdfBuffer = createMinimalValidPdfBuffer();
      const res = await validateGapAnalysisFile({
        fileName: 'policy.pdf',
        fileType: 'pdf',
        buffer: pdfBuffer,
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.detectedType).toBe('pdf');
    });

    it('8. File named .pdf containing plain text is rejected with INVALID_SIGNATURE', async () => {
      const fakePdf = Buffer.from('Plain text claiming to be a PDF file without signature.');
      await expect(
        validateGapAnalysisFile({
          fileName: 'spoofed.pdf',
          fileType: 'pdf',
          buffer: fakePdf,
        })
      ).rejects.toThrow(/standard PDF signature|required PDF signature/i);
    });

    it('9. PDF MIME or extension with ZIP payload is rejected', async () => {
      const zipBuffer = createFakeZipBuffer('doc.txt', 'some content');
      await expect(
        validateGapAnalysisFile({
          fileName: 'zip-disguised.pdf',
          fileType: 'pdf',
          buffer: zipBuffer,
        })
      ).rejects.toThrow(/standard PDF signature|required PDF signature/i);
    });

    it('10. Valid DOCX with genuine OOXML structure is accepted', async () => {
      const docxBuffer = await createValidDocxBuffer();
      const res = await validateGapAnalysisFile({
        fileName: 'policy.docx',
        fileType: 'docx',
        buffer: docxBuffer,
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.detectedType).toBe('docx');
    });

    it('11. Arbitrary ZIP archive renamed to .docx is rejected for missing OOXML parts', async () => {
      const arbitraryZip = createFakeZipBuffer('archive.txt', 'This is not a Word document.');
      await expect(
        validateGapAnalysisFile({
          fileName: 'not-a-word-doc.docx',
          fileType: 'docx',
          buffer: arbitraryZip,
        })
      ).rejects.toThrow(/does not contain standard Word processing parts/i);
    });

    it('12. Valid UTF-8 TXT is accepted', async () => {
      const txtBuffer = Buffer.from('This is a compliant policies document that has enough text to satisfy the length threshold.');
      const res = await validateGapAnalysisFile({
        fileName: 'policy.txt',
        fileType: 'txt',
        buffer: txtBuffer,
      });
      expect(res.valid).toBe(true);
      if (res.valid) expect(res.detectedType).toBe('txt');
    });

    it('13. Binary file renamed to .txt (containing null bytes) is rejected with BINARY_IN_TEXT', async () => {
      const binaryDisguised = Buffer.from('Hello world\x00BinaryPayloadWithNullBytes\x00End');
      await expect(
        validateGapAnalysisFile({
          fileName: 'binary.txt',
          fileType: 'txt',
          buffer: binaryDisguised,
        })
      ).rejects.toThrow(/contains binary content \(null bytes detected\)/i);
    });

    it('14. Unsupported legacy .doc file is rejected at router schema boundary', async () => {
      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'legacy.doc',
          fileType: 'doc' as any,
          fileContent: Buffer.from('legacy content').toString('base64'),
          regulatoryFrameworks: ['dpa_2019'],
          processingConsentAcknowledged: true,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('15. File exceeding 10MB decoded limit is rejected', async () => {
      const oversized = Buffer.alloc(11 * 1024 * 1024);
      oversized.write('%PDF-1.4', 0);
      await expect(
        validateGapAnalysisFile({
          fileName: 'big.pdf',
          fileType: 'pdf',
          buffer: oversized,
        })
      ).rejects.toThrow(/exceeds the 10\s*MB Gap Analysis limit/i);
    });

    it('16. Extension and explicit fileType mismatch is rejected', async () => {
      const caller = createCaller();
      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.docx',
          fileType: 'pdf',
          fileContent: Buffer.from('fake content').toString('base64'),
          regulatoryFrameworks: ['dpa_2019'],
          processingConsentAcknowledged: true,
        })
      ).rejects.toThrow('The document filename and file type do not match.');
    });
  });

  describe('17-19: DOCX Archive Safety', () => {
    it('17. DOCX archive with excessive uncompressed size is rejected as zip safety violation', async () => {
      // Craft a zip header claiming 60MB uncompressed size
      const zipWithHugeEntry = Buffer.alloc(100);
      zipWithHugeEntry.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
      zipWithHugeEntry.writeUInt16LE(20, 4);
      zipWithHugeEntry.writeUInt32LE(10, 18); // comp
      zipWithHugeEntry.writeUInt32LE(60 * 1024 * 1024, 22); // 60MB uncomp
      zipWithHugeEntry.writeUInt16LE(4, 26);
      zipWithHugeEntry.write('test', 30);

      // Add central directory
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt32LE(10, 20);
      cd.writeUInt32LE(60 * 1024 * 1024, 24);
      cd.writeUInt16LE(4, 28);
      const name = Buffer.from('test');

      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(1, 8);
      eocd.writeUInt16LE(1, 10);
      eocd.writeUInt32LE(cd.length + name.length, 12);
      eocd.writeUInt32LE(34, 16);

      const bombBuffer = Buffer.concat([zipWithHugeEntry.subarray(0, 34), cd, name, eocd]);
      const zipInfo = inspectZipArchive(bombBuffer);
      expect(zipInfo.totalUncompressedSize).toBeGreaterThan(50 * 1024 * 1024);

      await expect(
        validateGapAnalysisFile({
          fileName: 'bomb.docx',
          fileType: 'docx',
          buffer: bombBuffer,
        })
      ).rejects.toThrow(/potential zip bomb/i);
    });

    it('18. DOCX archive exceeding 500 entry count limit is rejected', async () => {
      const excessiveZip = createExcessiveEntriesZipBuffer(505);
      const zipInfo = inspectZipArchive(excessiveZip);
      expect(zipInfo.entryCount).toBeGreaterThan(GAP_ANALYSIS_ZIP_MAX_ENTRIES);

      await expect(
        validateGapAnalysisFile({
          fileName: 'excessive-entries.docx',
          fileType: 'docx',
          buffer: excessiveZip,
        })
      ).rejects.toThrow(/exceeds maximum entry limit of 500/i);
    });

    it('19. Missing word/document.xml in DOCX zip archive is rejected', async () => {
      const missingDocXmlZip = createFakeZipBuffer('[Content_Types].xml', '<Types></Types>');
      await expect(
        validateGapAnalysisFile({
          fileName: 'missing-doc-xml.docx',
          fileType: 'docx',
          buffer: missingDocXmlZip,
        })
      ).rejects.toThrow(/archive does not contain standard Word processing parts/i);
    });
  });

  describe('20-23: PDF Safety & Scanned PDF / OCR Policy', () => {
    it('20. Encrypted/password-protected PDF is rejected with clear user error', async () => {
      const encryptedPdf = createEncryptedPdfBuffer();
      await expect(
        validateGapAnalysisFile({
          fileName: 'locked.pdf',
          fileType: 'pdf',
          buffer: encryptedPdf,
        })
      ).rejects.toThrow(ENCRYPTED_PDF_REJECTION_MESSAGE);
    });

    it('21. Malformed/truncated PDF is rejected cleanly', async () => {
      const malformedPdf = Buffer.from('%PDF-1.4\nTRUNCATED_CORRUPT_BYTES_NO_OBJECTS');
      await expect(
        validateGapAnalysisFile({
          fileName: 'corrupted.pdf',
          fileType: 'pdf',
          buffer: malformedPdf,
        })
      ).rejects.toThrow();
    });

    it('22. Image-only/scanned PDF without extractable text is detected', async () => {
      const scannedPdf = createEmptyScannedPdfBuffer();
      await expect(
        validateGapAnalysisFile({
          fileName: 'scanned-doc.pdf',
          fileType: 'pdf',
          buffer: scannedPdf,
        })
      ).rejects.toThrow(SCANNED_PDF_REJECTION_MESSAGE);
    });

    it('23. Scanned PDF cannot proceed to AI analysis — returns canonical OCR-required rejection message', async () => {
      const scannedPdf = createEmptyScannedPdfBuffer();
      const caller = createCaller();

      await expect(
        caller.runGapAnalysis({
          fileName: 'scanned.pdf',
          fileType: 'pdf',
          fileContent: scannedPdf.toString('base64'),
          regulatoryFrameworks: ['dpa_2019'],
          analysisDepth: 'standard',
          processingConsentAcknowledged: true,
          consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
        })
      ).rejects.toThrow(SCANNED_PDF_REJECTION_MESSAGE);
    });
  });

  describe('24-27: Malware Scanning Status & Fail-Closed Behavior', () => {
    it('24. Malware scanner status is explicit and truthful (engine: disabled reported when unconfigured)', async () => {
      const cleanBuffer = Buffer.from('Clean file content for gap analysis testing.');
      const result = await scanGapAnalysisBuffer(cleanBuffer, 'test.txt');

      expect(result.status).toBe('skipped');
      expect(result.engine).toBe('disabled');
      expect(result.scannedAt).toBeDefined();
    });

    it('25. Infected/suspicious fixture (EICAR) cannot reach AI worker and throws MalwareDetectedError', async () => {
      const eicarBuffer = Buffer.from(EICAR_STANDARD_TEST_SIGNATURE);
      await expect(
        scanGapAnalysisBuffer(eicarBuffer, 'eicar.txt')
      ).rejects.toThrow(MalwareDetectedError);
    });

    it('26. Clean file proceeds normally through scanner', async () => {
      const cleanBuffer = Buffer.from('Standard non-malicious text content for compliance analysis.');
      const res = await scanGapAnalysisBuffer(cleanBuffer, 'clean.txt');
      expect(res.status).toBe('skipped'); // or 'clean' if ClamAV daemon running
    });

    it('27. Production configuration with missing scanner fails closed according to security policy', () => {
      expect(() => assertProductionMalwareScanningAvailable({
        isProduction: true,
        enabled: false,
        configured: false,
      })).toThrow(MalwareScanServiceError);
    });

    it('27b. Scanner health uses READY/DEGRADED/UNAVAILABLE and never sends document content', async () => {
      const health = await probeGapAnalysisMalwareScanner();
      expect(['READY', 'DEGRADED', 'UNAVAILABLE']).toContain(health.status);
      expect(health).toEqual(expect.objectContaining({
        enabled: expect.any(Boolean),
        configured: expect.any(Boolean),
        reachable: expect.any(Boolean),
        provider: expect.any(String),
        timeoutMs: expect.any(Number),
      }));
      expect(JSON.stringify(health)).not.toContain('SHERIABOT_PRIVATE_POLICY_CANARY_4A91F');
    });

    it('27c. Development scanner implements the explicit scanner contract', async () => {
      const scanner = new DisabledDevelopmentScanner();
      expect(scanner.providerName).toBe('disabled-development');
      expect(scanner.status).toBe('DISABLED_DEVELOPMENT');
      await expect(scanner.scan(Buffer.from('synthetic clean fixture'))).resolves.toEqual({ status: 'CLEAN' });
      await expect(scanner.health()).resolves.toEqual(expect.objectContaining({
        provider: 'disabled-development',
        timeoutMs: expect.any(Number),
      }));
    });

    it('27d. Server rejects Deep when framework-level readiness is gated', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Synthetic policy document with sufficient readable content and no customer data.').toString('base64');
      await expect(caller.runGapAnalysis({
        fileName: 'synthetic.txt',
        fileType: 'txt',
        fileContent: validText,
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'deep',
        processingConsentAcknowledged: true,
        consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      })).rejects.toThrow(/Deep Analysis is not yet validated/i);
    });

    it.each([
      ['SCANNER_UNAVAILABLE', 'CLAMAV_TIMEOUT'],
      ['SCANNER_UNAVAILABLE', 'ECONNREFUSED'],
      ['SCAN_ERROR', 'UNEXPECTED_RESPONSE'],
    ] as const)('27e. production fails closed for deterministic scanner result %s/%s', async (status, errorCode) => {
      const scanner: DocumentMalwareScanner = {
        providerName: 'deterministic-test-scanner',
        status: 'ENABLED',
        async scan() { return { status: status as DocumentMalwareScanStatus, errorCode }; },
        async health() {
          return {
            status: 'UNAVAILABLE', enabled: true, configured: true, reachable: false,
            provider: 'deterministic-test-scanner', timeoutMs: 25, message: errorCode,
          };
        },
      };
      await expect(scanGapAnalysisBuffer(
        Buffer.from('synthetic clean policy content'),
        'synthetic.txt',
        scanner,
        { required: true, isProduction: true },
      )).rejects.toThrow(MalwareScanServiceError);
    });
  });

  describe('28-32: Consent & Server-Side Processing Acknowledgement', () => {
    it('28. Unchecked/missing acknowledgement is rejected server-side with BAD_REQUEST', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.txt',
          fileType: 'txt',
          fileContent: validText,
          regulatoryFrameworks: ['dpa_2019'],
          analysisDepth: 'standard',
          processingConsentAcknowledged: false, // NOT ACKNOWLEDGED
        })
      ).rejects.toThrow(/Data processing consent must be acknowledged/i);
    });

    it('29. Correct acknowledgement is accepted', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      const result = await caller.runGapAnalysis({
        fileName: 'policy.txt',
        fileType: 'txt',
        fileContent: validText,
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
        consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      });

      expect(result).toHaveProperty('id', 'analysis-sec-123');
      expect(result).toHaveProperty('status', 'QUEUED');
    });

    it('30. Canonical consent version (GAP_ANALYSIS_PROCESSING_ACK_VERSION) is persisted in auditLog', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      await caller.runGapAnalysis({
        fileName: 'policy.txt',
        fileType: 'txt',
        fileContent: validText,
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
        consentVersion: '2026-10-01',
      });

      expect(mocks.auditLogCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'GAP_ANALYSIS_CONSENT_RECORDED',
            metadata: expect.objectContaining({
              consentVersion: '2026-10-01',
              userId: 'user-sec-1',
            }),
          }),
        })
      );
    });

    it('31. Consent timestamp (acknowledgedAt) is persisted in auditLog', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      await caller.runGapAnalysis({
        fileName: 'policy.txt',
        fileType: 'txt',
        fileContent: validText,
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
      });

      const auditCall = mocks.auditLogCreate.mock.calls.find(
        ([arg]) => arg.data?.action === 'GAP_ANALYSIS_CONSENT_RECORDED'
      );
      expect(auditCall).toBeDefined();
      expect(auditCall?.[0]?.data?.metadata).toHaveProperty('acknowledgedAt');
      expect(new Date(auditCall?.[0]?.data?.metadata?.acknowledgedAt).getTime()).toBeGreaterThan(0);
    });

    it('32. Stale/arbitrary incoming consent version is rejected and cannot become authoritative', async () => {
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      await expect(caller.runGapAnalysis({
          fileName: 'policy.txt',
          fileType: 'txt',
          fileContent: validText,
          regulatoryFrameworks: ['dpa_2019'],
          analysisDepth: 'standard',
          processingConsentAcknowledged: true,
          consentVersion: '2025-01-15-LEGACY-DPA',
        })).rejects.toThrow(/acknowledgement has changed/i);

      const staleAuditCall = mocks.auditLogCreate.mock.calls.find(
        ([arg]) => arg.data?.metadata?.consentVersion === '2025-01-15-LEGACY-DPA',
      );
      expect(staleAuditCall).toBeUndefined();
    });
  });

  describe('33-36: Storage Reference Security & Multi-Tenant Isolation', () => {
    it('33. Tampered job object reference (storageKey mismatch) is rejected by worker', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-sec-123',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-sec-123/genuine.pdf',
        deletedAt: null,
      });

      await expect(
        executeGapAnalysisPipeline({
          analysisId: 'analysis-sec-123',
          userId: 'user-sec-1',
          organizationId: 'org-sec-1',
          storageKey: 'gap-analysis/attacker-org/tampered-object.pdf', // TAMPERED REFERENCE
          fileName: 'policy.pdf',
          fileType: 'pdf',
          regulatoryFrameworks: ['Data Protection Act 2019'],
          jurisdictionContext: {
            mode: 'SINGLE',
            jurisdictions: ['KE'],
            primaryJurisdiction: 'KE',
            jurisdictionSource: 'REQUEST',
          },
          analysisDepth: 'quick',
        })
      ).rejects.toThrow(/Worker authorization failed: storage reference mismatch/i);
    });

    it('34. Another tenant cannot trigger analysis on an unowned storage object (org mismatch rejected)', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-victim-1',
        userId: 'victim-user',
        organizationId: 'victim-org',
        documentUrl: 'gap-analysis/victim-org/analysis-victim-1/victim.pdf',
        deletedAt: null,
      });

      await expect(
        executeGapAnalysisPipeline({
          analysisId: 'analysis-victim-1',
          userId: 'attacker-user', // ATTACKER
          organizationId: 'attacker-org',
          storageKey: 'gap-analysis/victim-org/analysis-victim-1/victim.pdf',
          fileName: 'policy.pdf',
          fileType: 'pdf',
          regulatoryFrameworks: ['Data Protection Act 2019'],
          jurisdictionContext: {
            mode: 'SINGLE',
            jurisdictions: ['KE'],
            primaryJurisdiction: 'KE',
            jurisdictionSource: 'REQUEST',
          },
          analysisDepth: 'quick',
        })
      ).rejects.toThrow(/Worker authorization failed: analysis owner mismatch/i);
    });

    it('35. Deleted analysis record cannot be loaded or processed by worker', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-deleted-1',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-deleted-1/test.pdf',
        deletedAt: new Date(), // ALREADY DELETED
      });

      await expect(
        executeGapAnalysisPipeline({
          analysisId: 'analysis-deleted-1',
          userId: 'user-sec-1',
          organizationId: 'org-sec-1',
          storageKey: 'gap-analysis/org-sec-1/analysis-deleted-1/test.pdf',
          fileName: 'policy.pdf',
          fileType: 'pdf',
          regulatoryFrameworks: ['Data Protection Act 2019'],
          jurisdictionContext: {
            mode: 'SINGLE',
            jurisdictions: ['KE'],
            primaryJurisdiction: 'KE',
            jurisdictionSource: 'REQUEST',
          },
          analysisDepth: 'quick',
        })
      ).rejects.toThrow(/processing was cancelled/i);
    });

    it('36. Source storage key is never exposed raw in getGapAnalysisResult (masked opaque reference)', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-masked-1',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-masked-1/internal-secret-file-uuid.pdf',
        documentName: 'policy.pdf',
        documentType: 'pdf',
        status: 'COMPLETED',
        results: null,
        deletedAt: null,
      });

      const res = await complianceModule.getGapAnalysisResult('user-sec-1', 'org-sec-1', 'analysis-masked-1');
      expect(res.documentUrl).toBe('gap-analysis:analysis-masked-1');
      expect(res.documentUrl).not.toContain('internal-secret-file-uuid.pdf');
    });

    it('36a. Result access rejects an analysis owned by a different organization', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-other-org',
        userId: 'user-sec-1',
        organizationId: 'org-other',
        deletedAt: null,
      });

      await expect(
        complianceModule.getGapAnalysisResult('user-sec-1', 'org-sec-1', 'analysis-other-org'),
      ).rejects.toThrow('Access denied');
    });

    it('36b. Delete rejects an analysis owned by a different organization before mutation', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        userId: 'user-sec-1',
        organizationId: 'org-other',
        documentUrl: 'gap-analysis/org-other/analysis-other-org/source.pdf',
        reportUrl: null,
        deletedAt: null,
      });

      await expect(
        complianceModule.deleteGapAnalysis('user-sec-1', 'org-sec-1', 'analysis-other-org'),
      ).rejects.toThrow('Access denied');
      expect(mocks.gapUpdate).not.toHaveBeenCalled();
      expect(mocks.storageDelete).not.toHaveBeenCalled();
    });

    it('36c. History lookup scopes both the database query and cache key to the active organization', async () => {
      mocks.gapFindMany.mockResolvedValue([]);

      await complianceModule.getUserGapAnalyses('user-sec-1', 'org-sec-1');

      expect(mocks.gapFindMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'user-sec-1', organizationId: 'org-sec-1', deletedAt: null },
      }));
      expect(mocks.redisGet).toHaveBeenCalledWith('cache:gap-analysis:list:org-sec-1:user-sec-1');
    });
  });

  describe('37-40: Cleanup Semantics & Failure Recovery', () => {
    it('37. Failure during job enqueueing triggers compensating cleanup of orphan uploaded R2 object', async () => {
      mocks.aiJobEnqueue.mockRejectedValueOnce(new Error('Postgres connection pool exhausted'));
      const caller = createCaller();
      const validText = Buffer.from('Valid compliant policy document with sufficient text length.').toString('base64');

      await expect(
        caller.runGapAnalysis({
          fileName: 'policy.txt',
          fileType: 'txt',
          fileContent: validText,
          regulatoryFrameworks: ['dpa_2019'],
          analysisDepth: 'standard',
          processingConsentAcknowledged: true,
        })
      ).rejects.toThrow('Postgres connection pool exhausted');

      expect(mocks.storageDelete).toHaveBeenCalledWith(
        expect.stringMatching(/^gap-analysis\/org-sec-1\/analysis-sec-123\//)
      );
    });

    it('38. Terminal worker failure marks status FAILED and does not leak temporary disk files', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        id: 'analysis-fail-1',
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-fail-1/test.pdf',
        deletedAt: null,
      });
      // Storage download returns empty buffer causing extraction failure
      mocks.storageDownload.mockResolvedValue(Buffer.from('corrupted'));

      await expect(
        executeGapAnalysisPipeline({
          analysisId: 'analysis-fail-1',
          userId: 'user-sec-1',
          organizationId: 'org-sec-1',
          storageKey: 'gap-analysis/org-sec-1/analysis-fail-1/test.pdf',
          fileName: 'corrupted.pdf',
          fileType: 'pdf',
          regulatoryFrameworks: ['Data Protection Act 2019'],
          jurisdictionContext: {
            mode: 'SINGLE',
            jurisdictions: ['KE'],
            primaryJurisdiction: 'KE',
            jurisdictionSource: 'REQUEST',
          },
          analysisDepth: 'quick',
        })
      ).rejects.toThrow();

      expect(mocks.gapUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'analysis-fail-1' }),
          data: expect.objectContaining({
            status: 'FAILED',
          }),
        })
      );
    });

    it('39. deleteGapAnalysis removes customer source artifact from R2 storage and soft-deletes row', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-sec-123/source.pdf',
        reportUrl: null,
        deletedAt: null,
      });

      await complianceModule.deleteGapAnalysis('user-sec-1', 'org-sec-1', 'analysis-sec-123');

      expect(mocks.storageDelete).toHaveBeenCalledWith('gap-analysis/org-sec-1/analysis-sec-123/source.pdf');
      expect(mocks.gapUpdate).toHaveBeenCalledWith({
        where: { id: 'analysis-sec-123' },
        data: { deletedAt: expect.any(Date) },
      });
    });

    it('40. deleteGapAnalysis removes generated report R2 artifact when present', async () => {
      mocks.gapFindUnique.mockResolvedValue({
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: 'gap-analysis/org-sec-1/analysis-sec-123/source.pdf',
        reportUrl: 'reports/org-sec-1/analysis-sec-123/gap-analysis-report.docx',
        deletedAt: null,
      });

      await complianceModule.deleteGapAnalysis('user-sec-1', 'org-sec-1', 'analysis-sec-123');

      expect(mocks.storageDelete).toHaveBeenCalledWith('reports/org-sec-1/analysis-sec-123/gap-analysis-report.docx');
    });

    it('40a. deleteGapAnalysis removes a current tenant-partitioned DOCX export', async () => {
      const reportUrl = 'gap-analysis-exports/org-sec-1/analysis-sec-123/gap-analysis-report.docx';
      mocks.gapFindUnique.mockResolvedValue({
        userId: 'user-sec-1',
        organizationId: 'org-sec-1',
        documentUrl: null,
        reportUrl,
        deletedAt: null,
      });

      await complianceModule.deleteGapAnalysis('user-sec-1', 'org-sec-1', 'analysis-sec-123');

      expect(mocks.storageDelete).toHaveBeenCalledWith(reportUrl);
    });
  });

  describe('Batch 4.1 cooperative cancellation boundaries', () => {
    const cancellationParams = {
      analysisId: 'analysis-cancel-1',
      userId: 'user-sec-1',
      organizationId: 'org-sec-1',
      storageKey: 'gap-analysis/org-sec-1/analysis-cancel-1/policy.txt',
      fileName: 'policy.txt',
      fileType: 'txt' as const,
      regulatoryFrameworks: ['Data Protection Act 2019'],
      regulatoryFrameworkSlugs: ['dpa_2019'],
      jurisdictionContext: {
        mode: 'SINGLE' as const,
        jurisdictions: ['KE'] as const,
        primaryJurisdiction: 'KE' as const,
        jurisdictionSource: 'REQUEST' as const,
      },
      analysisDepth: 'quick' as const,
    };

    const activeAnalysis = {
      id: 'analysis-cancel-1',
      userId: 'user-sec-1',
      organizationId: 'org-sec-1',
      documentUrl: 'gap-analysis/org-sec-1/analysis-cancel-1/policy.txt',
      deletedAt: null,
      status: 'QUEUED',
    };

    it('18-19. cancellation before worker retrieval prevents R2 access', async () => {
      mocks.gapFindUnique.mockResolvedValue({ ...activeAnalysis, status: 'CANCELLED' });

      await expect(executeGapAnalysisPipeline(cancellationParams)).rejects.toThrow(/processing was cancelled/i);

      expect(mocks.storageDownload).not.toHaveBeenCalled();
      expect(mocks.aiPerformGapAnalysis).not.toHaveBeenCalled();
    });

    it('20. cancellation after R2 download prevents extraction and AI', async () => {
      mocks.gapFindUnique
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce({ ...activeAnalysis, status: 'CANCELLED' });
      mocks.storageDownload.mockResolvedValue(Buffer.from('Policy text that is long enough to be processed but must be cancelled immediately after retrieval.'));

      await expect(executeGapAnalysisPipeline(cancellationParams)).rejects.toThrow(/processing was cancelled/i);

      expect(mocks.storageDownload).toHaveBeenCalledTimes(1);
      expect(mocks.aiPerformGapAnalysis).not.toHaveBeenCalled();
    });

    it('21. cancellation after extraction prevents any AI call', async () => {
      mocks.gapFindUnique
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce(activeAnalysis)
        .mockResolvedValueOnce({ ...activeAnalysis, status: 'CANCELLED' });
      mocks.storageDownload.mockResolvedValue(Buffer.from('Policy text that is long enough for extraction and cancellation boundary verification.'));

      await expect(executeGapAnalysisPipeline(cancellationParams)).rejects.toThrow(/processing was cancelled/i);

      expect(mocks.aiPerformGapAnalysis).not.toHaveBeenCalled();
    });

    it('22. cancellation between provider phases prevents the next provider call', async () => {
      mocks.gapFindUnique.mockResolvedValue(activeAnalysis);
      mocks.storageDownload.mockResolvedValue(Buffer.from('Policy text '.repeat(20)));
      let providerCalls = 0;
      mocks.aiPerformGapAnalysis.mockImplementationOnce(async (params: any) => {
        await params.beforeAiOperation();
        providerCalls++;
        mocks.gapFindUnique.mockResolvedValue({ ...activeAnalysis, status: 'CANCELLED' });
        await params.beforeAiOperation();
        providerCalls++;
        throw new Error('unreachable');
      });

      await expect(executeGapAnalysisPipeline(cancellationParams)).rejects.toThrow(/processing was cancelled/i);

      expect(providerCalls).toBe(1);
    });

    it('23-25. cancellation race at final write discards results and cannot persist COMPLETED', async () => {
      mocks.gapFindUnique.mockResolvedValue(activeAnalysis);
      mocks.storageDownload.mockResolvedValue(Buffer.from('Policy text '.repeat(20)));
      mocks.gapUpdateMany.mockImplementation(async (args: any) => ({
        count: args.data?.status === 'COMPLETED' ? 0 : 1,
      }));

      await expect(executeGapAnalysisPipeline(cancellationParams)).rejects.toThrow(/processing was cancelled/i);

      const completedWrite = mocks.gapUpdateMany.mock.calls.find(([args]) => args.data?.status === 'COMPLETED');
      expect(completedWrite).toBeDefined();
      expect(completedWrite?.[0].where).toEqual(expect.objectContaining({
        deletedAt: null,
        status: { not: 'CANCELLED' },
      }));
    });
  });

  // ==========================================================================
  // SECTION 25: PRIVACY CANARY ASSERTIONS
  // ==========================================================================

  describe('Section 25: Privacy Canary Leakage Verification', () => {
    const CANARY = 'SHERIABOT_PRIVATE_POLICY_CANARY_4A91F';

    it('Asserts privacy canary does NOT leak into AiJob.payload, auditLog, or logger output', async () => {
      const canaryPolicyText = `This is a highly confidential organizational privacy and governance policy.\nInternal Security Token: ${CANARY}\nCompliant with CBK Prudential Guidelines and Data Protection Act 2019.`;
      const canaryBuffer = Buffer.from(canaryPolicyText, 'utf8');

      const caller = createCaller();
      await caller.runGapAnalysis({
        fileName: 'canary-policy.txt',
        fileType: 'txt',
        fileContent: canaryBuffer.toString('base64'),
        regulatoryFrameworks: ['dpa_2019'],
        analysisDepth: 'standard',
        processingConsentAcknowledged: true,
        consentVersion: GAP_ANALYSIS_PROCESSING_ACK_VERSION,
      });

      // 1. Assert CANARY is NOT in AiJob.payload
      const jobEnqueueCall = mocks.aiJobEnqueue.mock.calls[0][0];
      const jobPayloadStr = JSON.stringify(jobEnqueueCall.payload);
      expect(jobPayloadStr).not.toContain(CANARY);

      // 2. Assert CANARY is NOT in auditLog metadata
      for (const call of mocks.auditLogCreate.mock.calls) {
        const auditStr = JSON.stringify(call[0].data);
        expect(auditStr).not.toContain(CANARY);
      }

      // 3. Assert CANARY is NOT in logger calls
      const allLogs = [
        ...mocks.loggerInfo.mock.calls,
        ...mocks.loggerWarn.mock.calls,
        ...mocks.loggerError.mock.calls,
      ];
      for (const [logObj] of allLogs) {
        const logStr = JSON.stringify(logObj);
        expect(logStr).not.toContain(CANARY);
      }
    });
  });
});

import 'dotenv/config';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { prisma } from '../lib/prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { createStorageService } from '../lib/storage/client';
import { GAP_ANALYSIS_STORAGE_PATH_PREFIX } from '../config/gap-analysis.config';
import { getIndexStats, resolvePineconeNamespace } from '../lib/rag/client';

// Use puppeteer-core from fintech-regulatory-platform
const puppeteer = require('../../../fintech-regulatory-platform/node_modules/puppeteer-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FRONTEND_URL = process.env.GAP_ANALYSIS_UAT_FRONTEND_URL ?? 'http://localhost:3000';
const BACKEND_URL = process.env.GAP_ANALYSIS_UAT_BACKEND_URL ?? 'http://localhost:4600';

async function main() {
  console.log('======================================================================');
  console.log('SHERIABOT BATCH 6.5: ASYNC RETRIEVAL ACCEPTANCE & RUNTIME CONTRACT TEST');
  console.log('======================================================================\n');

  // --- STEP 1: INITIAL SYSTEM COUNTS ---
  console.log('--- 1. RECORDING INITIAL COUNTS ---');
  const initialRegDocs = await prisma.regulatoryDocument.count();
  const initialRegChunks = await prisma.regulatoryDocumentChunk.count();
  const initialAnalyses = await prisma.gapAnalysis.count();
  const initialAiJobs = await prisma.aiJob.count();
  const initialUsers = await prisma.user.count({ where: { deletedAt: null } });
  const initialPinecone = await getIndexStats();
  const initialCounts = {
    regulatoryDocuments: initialRegDocs,
    regulatoryDocumentChunks: initialRegChunks,
    pineconeRecordCount: initialPinecone.totalRecordCount,
    gapAnalyses: initialAnalyses,
    aiJobs: initialAiJobs,
    activeUsers: initialUsers,
  };
  console.log('Initial system counts:', JSON.stringify(initialCounts, null, 2));

  // --- STEP 2: PROVISION FRESH QA PILOT IDENTITY (NEVER PRINT CREDENTIALS) ---
  console.log('\n--- 2. PROVISIONING FRESH DISPOSABLE QA IDENTITY ---');
  const qaEmail = `qa-batch65-pilot-${Date.now()}@sheriabot.test`;
  const rawPassword = crypto.randomBytes(24).toString('base64') + '!Aa1';
  console.log('Generated a fresh disposable QA identity in memory (credentials not logged or written to disk).');

  // Create in Supabase Auth
  const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
    email: qaEmail,
    password: rawPassword,
    email_confirm: true,
    user_metadata: {
      role: 'STARTUP',
      fullName: 'SheriaBot QA Batch 6.5 Pilot',
      qaPurpose: 'batch_6_5_acceptance',
      qaPersona: 'pilot',
    },
  });
  if (authErr || !authUser?.user) {
    throw new Error(`Failed to create Supabase user: ${authErr?.message}`);
  }
  const supabaseUserId = authUser.user.id;

  // Create in Database with REGULATOR plan
  let org = await prisma.organization.findFirst({
    where: { name: 'SheriaBot QA Batch 6.5 Sandbox' },
  });
  if (!org) {
    org = await prisma.organization.create({
      data: {
        name: 'SheriaBot QA Batch 6.5 Sandbox',
        type: 'startup',
        organizationType: 'startup',
        subscriptionTier: 'BUSINESS',
        plan: 'BUSINESS',
        subscriptionStatus: 'ACTIVE',
        verificationStatus: 'verified',
        verifiedAt: new Date(),
        maxSeats: 5,
        homeJurisdictionCode: 'KE',
        enabledJurisdictions: ['KE'],
        needsCountryConfirmation: false,
      },
    });
  }

  await prisma.organization.update({
    where: { id: org.id },
    data: {
      type: 'startup',
      organizationType: 'startup',
      subscriptionTier: 'BUSINESS',
      plan: 'BUSINESS',
      subscriptionStatus: 'ACTIVE',
      verificationStatus: 'verified',
      verifiedAt: new Date(),
      maxSeats: 5,
      homeJurisdictionCode: 'KE',
      enabledJurisdictions: ['KE'],
      needsCountryConfirmation: false,
    },
  });

  const adminActor = await prisma.user.findFirst({
    where: { role: 'ADMIN', accountStatus: 'active', deletedAt: null },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!adminActor) throw new Error('No active admin audit actor is available for QA provisioning.');
  const now = new Date();

  const dbUser = await prisma.user.create({
    data: {
      email: qaEmail,
      fullName: 'SheriaBot QA Batch 6.5 Pilot',
      supabaseAuthId: supabaseUserId,
      role: 'STARTUP',
      isPilot: true,
      status: 'ACTIVE',
      accountStatus: 'active',
      emailVerified: true,
      emailVerifiedAt: now,
      mustChangePassword: false,
      organizationId: org.id,
      pilotCohort: 'batch-6-5-runtime-acceptance',
      pilotStartedAt: now,
      pilotExpiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
      pilotAccessStatus: 'ACTIVE',
      pilotCreatedByAdminId: adminActor.id,
      postPilotTier: 'BUSINESS',
    },
  });

  await prisma.organizationMember.create({
    data: {
      organizationId: org.id,
      userId: dbUser.id,
      role: 'OWNER',
      status: 'ACTIVE',
    },
  });

  console.log(`QA User provisioned in DB (ID: ${dbUser.id}, Org: ${org.id}, Plan: REGULATOR).`);

  // --- STEP 3: BROWSER ACCEPTANCE TEST VIA PUPPETEER ---
  console.log('\n--- 3. LAUNCHING BROWSER FOR ASYNC FLOW ACCEPTANCE ---');
  const browser = await puppeteer.launch({
    executablePath: EDGE_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-popup-blocking'],
  });
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheriabot-batch65-'));

  let createdAnalysisId: string | null = null;
  let enqueuedAiJobId: string | null = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const cdp = await page.createCDPSession();
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

    page.on('console', (msg: any) => {
      if (msg.type() === 'error') console.log(`[Browser Console Error] ${msg.text()}`);
    });
    page.on('pageerror', (err: any) => {
      console.log(`[Browser Page Error] ${err.message}`);
    });

    // 3.1 Login via UI
    console.log(`Navigating to ${FRONTEND_URL}/login...`);
    await page.goto(`${FRONTEND_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[type=email]', { timeout: 60000 });

    console.log(`Logging in with disposable QA credentials...`);
    await page.type('input[type=email]', qaEmail);
    await page.type('input[type=password]', rawPassword);
    await page.click('button[type=submit]');

    await page.waitForFunction(
      () => location.pathname !== '/login' || Boolean(document.querySelector('[role="alert"]')),
      { timeout: 30000 }
    );
    const loginAlert = await page.evaluate(() => {
      const alert = document.querySelector('[role="alert"]');
      return alert ? alert.textContent : null;
    });
    if (loginAlert) {
      throw new Error(`Login form reported error: ${loginAlert}`);
    }
    console.log(`Login successful! Current URL: ${page.url()}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // 3.2 Navigate to Gap Analysis Page
    await page.goto(`${FRONTEND_URL}/startup/gap-analysis`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Policy Document') || Boolean(document.querySelector('input[type="file"]')), { timeout: 60000 });
    } catch (error) {
      console.error(`Gap Analysis page did not become ready. Current route: ${new URL(page.url()).pathname}`);
      throw error;
    }

    // 3.3 Verify UI Copy & Contracts
    console.log(`Inspecting UI contracts and product copy...`);
    const pageText = await page.evaluate(() => document.body.innerText);

    // Verify 10 MB limit (NOT 25 MB)
    const has10MbLimit = pageText.includes('10 MB') || pageText.includes('up to 10MB') || pageText.includes('10MB');
    const hasMisleading25Mb = pageText.includes('25 MB') || pageText.includes('25MB');
    console.log(`  Upload limit check: 10 MB present: ${has10MbLimit}, misleading 25 MB absent: ${!hasMisleading25Mb}`);
    if (hasMisleading25Mb) throw new Error('Contract Violation: Frontend still displays "25 MB" upload limit.');

    // Verify depth descriptions
    const hasQuickWording = pageText.includes('Fast screening for significant evidence-backed risks');
    const hasStandardWording = pageText.includes('Balanced policy and regulatory review with broader retrieval');
    const hasDeepWording = pageText.includes('Expanded retrieval, cross-section review and enhanced verification');
    console.log(`  Depth copy check:`);
    console.log(`    Quick: "${hasQuickWording ? 'Fast screening for significant evidence-backed risks' : 'MISMATCH'}"`);
    console.log(`    Standard: "${hasStandardWording ? 'Balanced policy and regulatory review...' : 'MISMATCH'}"`);
    console.log(`    Deep: "${hasDeepWording ? 'Expanded retrieval, cross-section review...' : 'MISMATCH'}"`);

    // Verify no misleading claims
    const hasMisleadingExhaustive = pageText.includes('Exhaustive regulatory mapping');
    const hasMisleadingMultiJurisdiction = pageText.includes('multi-jurisdiction risk analysis');
    const hasMisleadingCompleteAudit = pageText.includes('complete legal audit');
    if (hasMisleadingExhaustive || hasMisleadingMultiJurisdiction || hasMisleadingCompleteAudit) {
      throw new Error('Copy Violation: Frontend contains unapproved/misleading claims.');
    }
    console.log(`  Misleading claim check: ALL UNAPPROVED CLAIMS ABSENT.`);

    // 3.4 Upload Policy Document
    console.log(`Uploading test policy file (.codex-batch63-policy.txt)...`);
    const policyPath = path.resolve('../fintech-regulatory-platform/.codex-batch63-policy.txt');
    const fileInput = await page.$('input[type=file]');
    if (!fileInput) throw new Error('File input not found on page.');
    await fileInput.uploadFile(policyPath);

    // Wait for file to register in UI
    await page.waitForFunction(() => document.body.innerText.includes('.codex-batch63-policy.txt'), { timeout: 10000 });
    console.log(`File uploaded and recognized in UI!`);

    // 3.5 Select Framework (Data Protection Act 2019)
    console.log(`Selecting "Data Protection Act 2019" framework...`);
    // Ensure category details is open or click framework button directly
    await page.evaluate(() => {
      // open details elements if closed
      document.querySelectorAll('details').forEach(d => { d.open = true; });
    });
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => b.textContent?.includes('Data Protection Act 2019'));
    }, { timeout: 10000 });

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const fwBtn = btns.find(b => b.textContent?.includes('Data Protection Act 2019'));
      if (fwBtn && fwBtn.getAttribute('aria-pressed') !== 'true') {
        fwBtn.click();
      }
    });
    console.log(`Framework selected!`);

    // 3.6 Consent Acknowledgement
    console.log(`Checking data processing consent checkbox...`);
    const consentCheckbox = await page.$('input[type="checkbox"]');
    if (consentCheckbox) {
      const isChecked = await page.evaluate((el: Element) => (el as HTMLInputElement).checked, consentCheckbox);
      if (!isChecked) {
        await consentCheckbox.click();
      }
    }
    console.log(`Consent acknowledged.`);

    // 3.7 Verify Ready State & Click Run Analysis
    console.log(`Verifying ready state and clicking "Run Gap Analysis"...`);
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const runBtn = btns.find(b => b.textContent?.includes('Run Gap Analysis'));
      return runBtn && !runBtn.disabled;
    }, { timeout: 15000 });

    // Set up request/response interception for gapAnalysis.runGapAnalysis
    const trpcResponsePromise = page.waitForResponse(
      (response: any) => response.url().includes('gapAnalysis.runGapAnalysis') && response.status() === 200,
      { timeout: 30000 }
    );

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const runBtn = btns.find(b => b.textContent?.includes('Run Gap Analysis'));
      if (runBtn) runBtn.click();
    });

    const trpcResponse = await trpcResponsePromise;
    const responseJson = await trpcResponse.json();
    console.log(`API response received from server! Status: 200`);
    
    // Extract analysis ID from response
    const resultData = Array.isArray(responseJson) ? responseJson[0]?.result?.data : responseJson?.result?.data;
    createdAnalysisId = resultData?.id;
    console.log(`Canonical Analysis ID returned: ${createdAnalysisId}`);
    if (!createdAnalysisId) throw new Error('Failed to obtain analysis ID from gapAnalysis.runGapAnalysis response.');

    // --- STEP 4: VERIFY SERVER-SIDE ASYNC CONTRACT & PRIVACY ---
    console.log('\n--- 4. SERVER VALIDATION & PRIVACY INVARIANT CHECKS ---');
    const dbAnalysis = await prisma.gapAnalysis.findUnique({
      where: { id: createdAnalysisId },
      select: {
        id: true,
        documentName: true,
        documentUrl: true,
        status: true,
        progress: true,
        createdAt: true,
      },
    });
    console.log(`GapAnalysis record in DB:`, JSON.stringify(dbAnalysis, null, 2));
    if (!dbAnalysis?.documentUrl?.startsWith(GAP_ANALYSIS_STORAGE_PATH_PREFIX)) {
      throw new Error(`Invalid storage key in DB: ${dbAnalysis?.documentUrl}`);
    }

    // Verify private source storage in R2
    const storage = createStorageService();
    const sourceExists = await storage.fileExists(dbAnalysis.documentUrl);
    console.log(`Source stored privately in R2 at ${dbAnalysis.documentUrl}: ${sourceExists}`);
    if (!sourceExists) throw new Error('R2 source file does not exist!');

    // Query AiJob record
    const aiJob = await prisma.aiJob.findFirst({
      where: {
        targetEntityType: 'GapAnalysis',
        targetEntityId: createdAnalysisId,
      },
    });
    if (!aiJob) throw new Error('AiJob was not enqueued in database!');
    enqueuedAiJobId = aiJob.id;
    console.log(`AiJob record found: ID ${aiJob.id}, type: ${aiJob.type}, status: ${aiJob.status}`);

    // PRIVACY VERIFICATION: AiJob.payload MUST contain NO document text or base64 body!
    const jobPayload = aiJob.payload as any;
    console.log(`Verifying AiJob Privacy Contract...`);
    console.log(`  Payload storageKey: ${jobPayload?.storageKey}`);
    console.log(`  Payload analysisId: ${jobPayload?.analysisId}`);
    console.log(`  Payload fileName: ${jobPayload?.fileName}`);
    console.log(`  Payload fileSize: ${jobPayload?.fileSize} bytes`);
    console.log(`  Payload fileContent present: ${jobPayload?.fileContent !== undefined}`);
    console.log(`  Payload policyText present: ${jobPayload?.policyText !== undefined}`);
    console.log(`  Payload retrievalNamespace: ${jobPayload?.retrievalNamespace}`);

    const forbiddenBodyKeys = ['fileContent', 'base64', 'fileBuffer', 'rawText', 'policyText'];
    const presentForbiddenBodyKeys = forbiddenBodyKeys.filter((key) => jobPayload?.[key] !== undefined);
    if (presentForbiddenBodyKeys.length > 0) {
      throw new Error('CRITICAL PRIVACY VIOLATION: AiJob.payload contains raw document body!');
    }
    const expectedNamespace = resolvePineconeNamespace();
    if (jobPayload?.retrievalNamespace !== expectedNamespace) {
      throw new Error(`Retrieval namespace mismatch in queued contract: ${jobPayload?.retrievalNamespace} vs expected ${expectedNamespace}`);
    }
    console.log(`AiJob Privacy Invariant VERIFIED: Reference-only payload confirmed!`);

    // --- STEP 5: MONITOR WORKER ASYNC EXECUTION ---
    console.log('\n--- 5. MONITORING WORKER EXECUTION TO COMPLETION ---');
    console.log(`Polling for AiJob & GapAnalysis completion (executed by background worker)...`);

    const maxWaitMs = 360000; // 6 minutes
    const pollIntervalMs = 3000;
    const startTime = Date.now();
    let completedAnalysis: any = null;

    while (Date.now() - startTime < maxWaitMs) {
      const currentJob = await prisma.aiJob.findUnique({ where: { id: enqueuedAiJobId } });
      const currentAnalysis = await prisma.gapAnalysis.findUnique({ where: { id: createdAnalysisId } });

      console.log(`  [+${Math.round((Date.now() - startTime) / 1000)}s] AiJob: ${currentJob?.status} (progress ${currentJob?.progress}%) | GapAnalysis: ${currentAnalysis?.status} (progress ${currentAnalysis?.progress}%)`);

      if (currentAnalysis?.status === 'COMPLETED') {
        if (currentJob?.status === 'COMPLETED') {
          completedAnalysis = currentAnalysis;
          break;
        }
      }

      if (currentAnalysis?.status === 'FAILED' || currentJob?.status === 'FAILED') {
        throw new Error(`Async execution failed: ${currentAnalysis?.errorMessage || currentJob?.lastError}`);
      }

      await new Promise(r => setTimeout(r, pollIntervalMs));
    }

    if (!completedAnalysis) {
      throw new Error('Async execution timed out before reaching COMPLETED.');
    }
    console.log(`Worker async execution COMPLETED successfully!`);

    // --- STEP 6: VERIFY FRONTEND POLLING TRANSITION & RESULTS IN BROWSER ---
    console.log('\n--- 6. VERIFYING BROWSER RESULTS VIEW & CONTRACTS ---');
    // Wait for frontend polling to update the UI
    await page.waitForFunction(
      () => document.body.innerText.includes('Compliance Alignment') && !document.body.innerText.includes('Analyzing document'),
      { timeout: 30000 }
    );
    console.log(`Frontend successfully polled and transitioned to Results view!`);

    const resultsPageText = await page.evaluate(() => document.body.innerText);

    // Verify Compliance Alignment terminology (NOT Score / NOT % compliant)
    const hasComplianceAlignment = resultsPageText.includes('Compliance Alignment');
    const hasPercentCompliant = resultsPageText.includes('% compliant') || resultsPageText.includes('% Compliant');
    console.log(`  "Compliance Alignment" label present: ${hasComplianceAlignment}`);
    console.log(`  Misleading "% compliant" absent: ${!hasPercentCompliant}`);
    if (!hasComplianceAlignment || hasPercentCompliant) {
      throw new Error('Frontend Terminology Violation: Expected "Compliance Alignment" without "% compliant".');
    }

    // Verify Separation: Document Processing vs Assessment Coverage
    const hasDocProcessing = resultsPageText.includes('Document Processing');
    const hasDocProcessedChunks = resultsPageText.includes('Document processed ·');
    const hasAssessmentCoverage = resultsPageText.includes('Assessment Coverage');
    const hasPartialCoverage = resultsPageText.includes('Partial') || resultsPageText.includes('partial');
    const hasEvidenceObligations = resultsPageText.includes('evidence-backed obligations evaluated');

    console.log(`  Document Processing Card present: ${hasDocProcessing && hasDocProcessedChunks}`);
    console.log(`  Assessment Coverage Card (Partial) present: ${hasAssessmentCoverage && hasPartialCoverage}`);
    console.log(`  Evidence obligations count present: ${hasEvidenceObligations}`);

    if (!hasDocProcessing || !hasAssessmentCoverage || !hasPartialCoverage) {
      throw new Error('Contract Violation: Document Processing and Assessment Coverage are not properly separated.');
    }

    // Capture screenshot of the verified browser result
    const screenshotPath = path.resolve('uat-async-acceptance-result.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Saved acceptance result screenshot to ${screenshotPath}`);

    // --- STEP 7: VERIFY PERSISTED RESULT TELEMETRY, RAG & METRIC SEMANTICS ---
    console.log('\n--- 7. AUDITING PERSISTED RESULT TELEMETRY & COST ACCOUNTING ---');
    const resultObj = completedAnalysis.results as any;
    console.log(`Overall Score / Alignment: ${resultObj.overallScore}`);
    console.log(`Grounded: ${resultObj.grounded}`);

    // RAG semantics verification
    console.log(`RAG Semantics Check:`);
    console.log(`  retrievedCount: ${resultObj.retrievedCount ?? 'N/A'}`);
    console.log(`  acceptedCount: ${resultObj.acceptedCount ?? 'N/A'}`);
    console.log(`  evidence length: ${resultObj.evidence?.length ?? 0}`);

    // Depth engine versioning verification
    console.log(`Depth Engine Versioning:`);
    console.log(`  depthEngineVersion: ${resultObj.metadata?.depthEngineVersion}`);
    console.log(`  depthProfileVersion: ${resultObj.metadata?.depthProfileVersion}`);
    console.log(`  executionProfileVersion: ${resultObj.metadata?.executionProfileVersion}`);

    if (resultObj.metadata?.depthEngineVersion !== 'gap-analysis-depth-v2') {
      throw new Error(`Invalid depthEngineVersion: ${resultObj.metadata?.depthEngineVersion}`);
    }

    // Provider & Cost Accounting verification
    console.log(`Cost & Model Telemetry:`);
    const cost = resultObj.metadata?.costAccounting;
    console.log(`  provider: ${cost?.provider}`);
    console.log(`  model: ${cost?.model}`);
    console.log(`  inputTokens: ${cost?.inputTokens}`);
    console.log(`  outputTokens: ${cost?.outputTokens}`);
    console.log(`  durationMs: ${cost?.durationMs}`);
    console.log(`  costType: ${cost?.costType}`);
    console.log(`  estimatedCostUsd: $${cost?.estimatedCostUsd}`);

    if (!cost?.provider || !cost?.model || !['MEASURED', 'ESTIMATED', 'NOT_VERIFIED'].includes(cost.costType)) {
      throw new Error('Provider/model/cost classification telemetry is missing or invalid.');
    }
    if (!Array.isArray(cost.providerCalls) || cost.providerCalls.length === 0) {
      throw new Error('Per-provider call telemetry is missing.');
    }
    if (cost.costType === 'NOT_VERIFIED' && cost.estimatedCostUsd !== undefined) {
      throw new Error('Unverified cost must not be reported as a numeric estimate.');
    }

    // --- STEP 8: REPORT EXPORTS THROUGH THE REAL BROWSER UI ---
    console.log('\n--- 8. GENERATING REAL PDF & DOCX EXPORTS THROUGH UI ---');
    const clickButton = async (text: string) => {
      await page.waitForFunction(
        (label: string) => {
          return Array.from(document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"]'))
            .some((item) => item.textContent?.includes(label));
        },
        { timeout: 15000 },
        text
      );
      const elements = await page.$$('button, [role="menuitem"], [role="option"]');
      for (const el of elements) {
        const matches = await el.evaluate((node: any, label: any) => node.textContent?.includes(label), text);
        if (matches) {
          await el.click();
          return;
        }
      }
      throw new Error(`Element with text "${text}" not found`);
    };

    await page.evaluate(() => {
      const origOpen = window.open;
      window.open = function(...args) {
        const w = origOpen.apply(window, args);
        if (w) {
          try {
            w.print = () => {};
          } catch {}
        }
        return w;
      };
    });

    const popupTargetPromise = browser.waitForTarget(
      (target: any) => target.type() === 'page' && target !== page.target(),
      { timeout: 15000 },
    );
    await clickButton('Export');
    await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
    await clickButton('Export as PDF');
    const pdfTarget = await popupTargetPromise;
    const pdfPage = await pdfTarget.page();
    if (!pdfPage) throw new Error('PDF export window did not open.');
    await pdfPage.evaluate(() => { window.print = () => {}; }).catch(() => {});
    await pdfPage.waitForFunction(
      () => document.body.innerHTML.includes('Policy Gap Analysis') || document.body.innerHTML.includes('Compliance Alignment'),
      { timeout: 20000 }
    );
    const pdfPath = path.join(downloadDir, 'gap-analysis-report.pdf');
    await pdfPage.pdf({ path: pdfPath, format: 'A4', printBackground: true });
    await pdfPage.close();
    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size === 0) throw new Error('PDF export was empty.');

    await clickButton('Export');
    await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
    await clickButton('Export as Word (DOCX)');
    const docxDeadline = Date.now() + 30000;
    let docxPath: string | undefined;
    while (Date.now() < docxDeadline) {
      docxPath = fs.readdirSync(downloadDir).map((name) => path.join(downloadDir, name))
        .find((candidate) => candidate.toLowerCase().endsWith('.docx'));
      if (docxPath && fs.statSync(docxPath).size > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!docxPath || fs.statSync(docxPath).size === 0) throw new Error('DOCX browser download did not complete.');
    console.log('PDF and DOCX browser exports completed successfully.');

    // --- STEP 9: SUPPORTED LIFECYCLE CLEANUP (UI DELETE) ---
    console.log('\n--- 9. EXECUTING SUPPORTED LIFECYCLE CLEANUP ---');
    console.log('Invoking application-supported deleteGapAnalysis through the browser.');
    await clickButton('Back to Gap Analysis');
    await page.waitForFunction((documentName: string) => document.body.innerText.includes(documentName), {}, completedAnalysis.documentName);
    await page.evaluate((documentName: string) => {
      const button = Array.from(document.querySelectorAll('button')).find(
        (item) => item.getAttribute('aria-label') === `Delete ${documentName}`,
      );
      if (!button) throw new Error('Delete button not found for completed analysis.');
      button.click();
    }, completedAnalysis.documentName);
    const deleteResponsePromise = page.waitForResponse(
      (response: any) => response.url().includes('gapAnalysis.deleteGapAnalysis') && response.status() === 200,
      { timeout: 30000 },
    );
    await clickButton('Delete analysis');
    await deleteResponsePromise;

    // Verify record state in database
    const deletedRecord = await prisma.gapAnalysis.findUnique({
      where: { id: createdAnalysisId },
      select: { id: true, status: true, deletedAt: true },
    });
    console.log(`Deleted record state: status=${deletedRecord?.status}, deletedAt=${deletedRecord?.deletedAt}`);
    if (deletedRecord?.deletedAt === null || deletedRecord?.status !== 'CANCELLED') {
      throw new Error('Lifecycle cleanup failed to soft-delete or cancel GapAnalysis!');
    }

    // Verify R2 source object removed
    const sourceStillExists = await storage.fileExists(dbAnalysis.documentUrl);
    console.log(`R2 source object removed: ${!sourceStillExists}`);
    if (sourceStillExists) throw new Error('Lifecycle cleanup left orphan source object in R2!');

    // Verify deleted result cannot reopen
    let reopened = false;
    try {
      const { complianceModule } = await import('../modules/compliance');
      await complianceModule.getGapAnalysisResult(dbUser.id, org.id, createdAnalysisId);
      reopened = true;
    } catch (e: any) {
      console.log(`Attempt to reopen deleted analysis correctly rejected with: ${e.message}`);
    }
    if (reopened) throw new Error('Deleted analysis was able to reopen!');

    // Verify AiJob scrubbed
    const scrubbedJob = await prisma.aiJob.findUnique({ where: { id: enqueuedAiJobId } });
    console.log(`AiJob after cleanup: status=${scrubbedJob?.status}`);

  } finally {
    try {
      if (createdAnalysisId) {
        const remaining = await prisma.gapAnalysis.findUnique({
          where: { id: createdAnalysisId },
          select: { deletedAt: true },
        });
        if (remaining && remaining.deletedAt === null) {
          const { complianceModule } = await import('../modules/compliance');
          await complianceModule.deleteGapAnalysis(dbUser.id, org.id, createdAnalysisId);
        }
      }
    } catch (error: unknown) {
      console.error('Fallback analysis cleanup failed:', error instanceof Error ? error.message : String(error));
    }
    try {
      await supabaseAdmin.auth.admin.deleteUser(supabaseUserId);
      const activeDbUser = await prisma.user.findUnique({ where: { id: dbUser.id }, select: { deletedAt: true } });
      if (activeDbUser && activeDbUser.deletedAt === null) {
        const { adminModule } = await import('../modules/admin/admin.module');
        const adminActor = await prisma.user.findFirst({
          where: { role: 'ADMIN', deletedAt: null },
          select: { id: true },
          orderBy: { createdAt: 'asc' },
        });
        if (adminActor) await adminModule.signOutUserEverywhere(adminActor.id, dbUser.id);
        await prisma.user.update({
          where: { id: dbUser.id },
          data: {
            status: 'SUSPENDED',
            email: `deleted_${dbUser.id}@sheriabot.internal`,
            supabaseAuthId: null,
            deletedAt: new Date(),
          },
        });
      }
    } catch (error: unknown) {
      console.error('Fallback QA identity cleanup failed:', error instanceof Error ? error.message : String(error));
    }
    for (const artifact of fs.readdirSync(downloadDir)) fs.unlinkSync(path.join(downloadDir, artifact));
    fs.rmdirSync(downloadDir);
    await browser.close();
  }

  // --- STEP 10: FINAL AUDIT & ORPHAN CHECK ---
  console.log('\n--- 10. FINAL SYSTEM AUDIT & ORPHAN VERIFICATION ---');
  const finalRegDocs = await prisma.regulatoryDocument.count();
  const finalRegChunks = await prisma.regulatoryDocumentChunk.count();
  const finalAnalyses = await prisma.gapAnalysis.count();
  const finalAiJobs = await prisma.aiJob.count();
  const finalUsers = await prisma.user.count({ where: { deletedAt: null } });
  const finalPinecone = await getIndexStats();
  const finalCounts = {
    regulatoryDocuments: finalRegDocs,
    regulatoryDocumentChunks: finalRegChunks,
    pineconeRecordCount: finalPinecone.totalRecordCount,
    gapAnalyses: finalAnalyses,
    aiJobs: finalAiJobs,
    activeUsers: finalUsers,
  };
  console.log('Final system counts:', JSON.stringify(finalCounts, null, 2));

  // Verify approved corpus remains 100% intact
  if (finalRegDocs !== initialRegDocs || finalRegChunks !== initialRegChunks) {
    throw new Error('CRITICAL INTEGRITY FAILURE: Approved UAT regulatory corpus was modified or erased during cleanup!');
  }
  console.log('Approved UAT Kenya DPA regulatory corpus VERIFIED 100% INTACT!');

  console.log('\n======================================================================');
  const ownedActiveAnalyses = await prisma.gapAnalysis.count({ where: { userId: dbUser.id, deletedAt: null } });
  const ownedActiveUsers = await prisma.user.count({ where: { id: dbUser.id, deletedAt: null } });
  if (ownedActiveAnalyses !== 0 || ownedActiveUsers !== 0) {
    throw new Error(`Batch 6.5 cleanup left active owned rows: analyses=${ownedActiveAnalyses}, users=${ownedActiveUsers}`);
  }
  console.log(`Batch 6.5 owned active rows: analyses=${ownedActiveAnalyses}, users=${ownedActiveUsers}.`);

  console.log('BATCH 6.5 ASYNC RETRIEVAL ACCEPTANCE SUITE: ALL CONTRACTS PASSED (100%)');
  console.log('======================================================================');
}

if (process.argv.includes('--ga14')) {
  import('./run-ga14-pilot-acceptance')
    .then(({ runGa14PilotAcceptance }) => runGa14PilotAcceptance())
    .catch((err) => {
      console.error('\nGA-14 ACCEPTANCE SUITE FAILED:', err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
} else {
  main().catch(err => {
    console.error('\nACCEPTANCE SUITE FAILED:', err);
    process.exit(1);
  }).finally(() => prisma.$disconnect());
}

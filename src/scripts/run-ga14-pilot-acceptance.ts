import 'dotenv/config';
import crypto from 'crypto';
import { BillingMetric } from '@prisma/client';
import { prisma } from '../lib/prisma/client';
import { supabaseAdmin } from '../lib/supabase';
import { redis } from '../lib/redis/client';
import { createStorageService } from '../lib/storage/client';

const puppeteer = require('../../../fintech-regulatory-platform/node_modules/puppeteer-core');

const EDGE_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FRONTEND_URL = process.env.GAP_ANALYSIS_UAT_FRONTEND_URL ?? 'http://localhost:3100';
const BACKEND_URL = process.env.GAP_ANALYSIS_UAT_BACKEND_URL ?? 'http://localhost:4600';
const BACKEND_TRPC_URL = `${BACKEND_URL.replace(/\/$/, '')}/trpc`;
const ACTIVE_ANALYSIS_STATUSES = ['UPLOADING', 'QUEUED', 'RUNNING', 'RETRYING', 'ANALYZING', 'COMPLETING'];
const ACTIVE_JOB_STATUSES = ['QUEUED', 'RUNNING', 'RETRYING'];
const PRIVATE_CANARY = 'SHERIABOT_OBSERVABILITY_PRIVATE_CANARY_7A91';

type Session = {
  page: any;
  userId: string;
  organizationId: string;
  authUserId: string;
  bearer: string;
};

type RequestPayload = {
  fileName: string;
  fileType: 'txt';
  fileContent: string;
  processingConsentAcknowledged: true;
  jurisdiction: 'KE';
  regulatoryFrameworks: string[];
  analysisDepth: 'quick' | 'standard';
  focusAreas: string[];
};

type ConcurrentResult = {
  index: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  status: number;
  ok: boolean;
  analysisId?: string;
  reused?: boolean;
  errorCode?: string;
  errorMessage?: string;
};

type RaceSnapshot = {
  gapAnalysisCount: number;
  activeAnalysisCount: number;
  executionIdentities: string[];
  statuses: string[];
  aiJobCount: number;
  activeJobCount: number;
  usage: number;
  sourceObjectCount: number;
  reportObjectCount: number;
};

type DevelopmentUatTargetSummary = {
  environmentId: string;
  databaseClassification: string;
  databaseHost: string;
  redisHost: string;
  r2Bucket: string;
  pineconeIndex: string;
  pineconeNamespace: string;
  supabaseProjectHost: string;
  frontendOrigin: string;
  backendOrigin: string;
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const PRODUCTION_HOSTS = new Set([
  'sheriabot.com',
  'www.sheriabot.com',
  'app.sheriabot.com',
  'api.sheriabot.com',
]);

function parseTargetUrl(label: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Development-UAT guard refused execution: ${label} is not a valid URL.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Development-UAT guard refused execution: ${label} must not contain credentials.`);
  }
  return parsed;
}

function requiredSafeIdentifier(name: string, value: string | undefined): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    throw new Error(`Development-UAT guard refused execution: ${name} is required.`);
  }
  return normalized;
}

function safeHostFromConnectionString(name: string, value: string | undefined): string {
  const parsed = parseTargetUrl(name, requiredSafeIdentifier(name, value));
  return parsed.hostname;
}

function assertDevelopmentUat(): DevelopmentUatTargetSummary {
  const environment = (process.env.DATABASE_ENVIRONMENT ?? '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV ?? '').split('#')[0].trim().toLowerCase();
  const runtime = (process.env.APP_RUNTIME_MODE ?? '').split('#')[0].trim().toLowerCase();
  const environmentId = requiredSafeIdentifier('GAP_ANALYSIS_UAT_ENVIRONMENT_ID', process.env.GAP_ANALYSIS_UAT_ENVIRONMENT_ID).toLowerCase();
  const confirmation = (process.env.GAP_ANALYSIS_UAT_CONFIRMATION ?? '').trim();
  const frontend = parseTargetUrl('GAP_ANALYSIS_UAT_FRONTEND_URL', FRONTEND_URL);
  const backend = parseTargetUrl('GAP_ANALYSIS_UAT_BACKEND_URL', BACKEND_URL);
  const targets = [frontend, backend];
  const remoteTargets = targets.filter(({ hostname }) => !LOCAL_HOSTS.has(hostname.toLowerCase()));
  const allowedRemoteHosts = new Set(
    (process.env.GAP_ANALYSIS_UAT_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );

  if (environment !== 'development-uat' || nodeEnv === 'production' || runtime === 'production') {
    throw new Error('Development-UAT guard refused execution: application or database environment is not Development-UAT.');
  }
  if (!environmentId.includes('development-uat') || /(^|[-_.])(prod|production)([-_.]|$)/.test(environmentId)) {
    throw new Error('Development-UAT guard refused execution: environment identifier is not explicitly Development-UAT.');
  }
  if (confirmation !== 'DEVELOPMENT_UAT_ONLY') {
    throw new Error('Development-UAT guard refused execution: GAP_ANALYSIS_UAT_CONFIRMATION must equal DEVELOPMENT_UAT_ONLY.');
  }
  for (const target of targets) {
    const host = target.hostname.toLowerCase();
    if (PRODUCTION_HOSTS.has(host) || host.endsWith('.sheriabot.com')) {
      throw new Error(`Development-UAT guard refused execution: production host ${host} is forbidden.`);
    }
  }
  for (const target of remoteTargets) {
    const host = target.hostname.toLowerCase();
    if (target.protocol !== 'https:') {
      throw new Error(`Development-UAT guard refused execution: remote host ${host} must use HTTPS.`);
    }
    if (!allowedRemoteHosts.has(host)) {
      throw new Error(`Development-UAT guard refused execution: remote host ${host} is not in GAP_ANALYSIS_UAT_ALLOWED_HOSTS.`);
    }
  }

  return {
    environmentId,
    databaseClassification: environment,
    databaseHost: safeHostFromConnectionString('DATABASE_URL', process.env.DATABASE_URL),
    redisHost: safeHostFromConnectionString('UPSTASH_REDIS_REST_URL', process.env.UPSTASH_REDIS_REST_URL),
    r2Bucket: requiredSafeIdentifier('R2_BUCKET_NAME', process.env.R2_BUCKET_NAME),
    pineconeIndex: requiredSafeIdentifier('PINECONE_INDEX_NAME', process.env.PINECONE_INDEX_NAME),
    pineconeNamespace: requiredSafeIdentifier('PINECONE_NAMESPACE', process.env.PINECONE_NAMESPACE),
    supabaseProjectHost: safeHostFromConnectionString('SUPABASE_URL', process.env.SUPABASE_URL),
    frontendOrigin: frontend.origin,
    backendOrigin: backend.origin,
  };
}

function usageKey(organizationId: string): string {
  const period = new Date().toISOString().slice(0, 7);
  return `sheriabot:usage:${organizationId}:${BillingMetric.GAP_ANALYSES}:${period}`;
}

async function readUsage(organizationId: string): Promise<number> {
  const raw = await redis.get<number | string>(usageKey(organizationId));
  return typeof raw === 'number' ? raw : Number(raw ?? 0);
}

async function setUsage(organizationId: string, value: number): Promise<void> {
  await redis.set(usageKey(organizationId), value, { ex: 35 * 24 * 60 * 60 });
}

function parseTrpcResponse(status: number, text: string, index: number, startedAt: number, endedAt: number): ConcurrentResult {
  try {
    const parsed = JSON.parse(text);
    const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
    const data = envelope?.result?.data?.json ?? envelope?.result?.data;
    const error = envelope?.error?.json ?? envelope?.error;
    return {
      index,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      status,
      ok: status >= 200 && status < 300 && Boolean(data?.id),
      analysisId: data?.id,
      reused: data?.reused,
      errorCode: error?.data?.code,
      errorMessage: error?.message,
    };
  } catch {
    return { index, startedAt, endedAt, durationMs: endedAt - startedAt, status, ok: false, errorMessage: 'Non-JSON response' };
  }
}

/**
 * Preconstructs every authenticated request, releases them behind one browser
 * barrier, and settles them together. Credentials remain in memory and are
 * never returned or logged.
 */
export async function runConcurrentGapAnalysisRequests(args: {
  count: number;
  authenticatedSession: Session;
  identicalOrDistinctPayloads: RequestPayload[];
}): Promise<ConcurrentResult[]> {
  if (args.identicalOrDistinctPayloads.length !== args.count) {
    throw new Error('The number of payloads must equal the requested concurrency.');
  }
  const raw = await args.authenticatedSession.page.evaluate(
    async ({ endpoint, bearer, payloads }: { endpoint: string; bearer: string; payloads: RequestPayload[] }) => {
      const requests = payloads.map((payload, index) => async () => {
        const startedAt = Date.now();
        try {
          const response = await fetch(`${endpoint}/gapAnalysis.runGapAnalysis?batch=1`, {
            method: 'POST',
            credentials: 'include',
            headers: { authorization: bearer, 'content-type': 'application/json' },
            body: JSON.stringify({ '0': { json: payload } }),
          });
          const text = await response.text();
          return { index, startedAt, endedAt: Date.now(), status: response.status, text };
        } catch (error) {
          return { index, startedAt, endedAt: Date.now(), status: 0, text: JSON.stringify({ error: { message: error instanceof Error ? error.message : 'fetch failed' } }) };
        }
      });
      const release = Promise.resolve();
      return Promise.all(requests.map(async (request) => { await release; return request(); }));
    },
    { endpoint: BACKEND_TRPC_URL, bearer: args.authenticatedSession.bearer, payloads: args.identicalOrDistinctPayloads },
  );
  return raw.map((item: any) => parseTrpcResponse(item.status, item.text, item.index, item.startedAt, item.endedAt));
}

async function invokeMutation(session: Session, procedure: string, input: Record<string, unknown>): Promise<{ status: number; data?: any; errorCode?: string }> {
  const raw = await session.page.evaluate(async ({ endpoint, bearer, procedureName, body }: any) => {
    const response = await fetch(`${endpoint}/${procedureName}?batch=1`, {
      method: 'POST', credentials: 'include',
      headers: { authorization: bearer, 'content-type': 'application/json' },
      body: JSON.stringify({ '0': { json: body } }),
    });
    return { status: response.status, text: await response.text() };
  }, { endpoint: BACKEND_TRPC_URL, bearer: session.bearer, procedureName: procedure, body: input });
  const parsed = JSON.parse(raw.text);
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  return { status: raw.status, data: envelope?.result?.data?.json ?? envelope?.result?.data, errorCode: envelope?.error?.json?.data?.code ?? envelope?.error?.data?.code };
}

async function provisionSession(browser: any, organizationId: string, label: string): Promise<Session> {
  const email = `qa-ga14-${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@sheriabot.test`;
  const password = `${crypto.randomBytes(24).toString('base64')}!Aa1`;
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { role: 'STARTUP', fullName: `GA-14 ${label}`, qaPurpose: 'ga14_pilot_acceptance' },
  });
  if (error || !data.user) throw new Error(`Disposable auth provisioning failed: ${error?.message ?? 'unknown error'}`);
  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN', accountStatus: 'active', deletedAt: null }, select: { id: true }, orderBy: { createdAt: 'asc' } });
  if (!admin) throw new Error('No active admin actor exists for UAT provisioning.');
  const now = new Date();
  const user = await prisma.user.create({ data: {
    email, fullName: `GA-14 ${label}`, supabaseAuthId: data.user.id, role: 'STARTUP', isPilot: true,
    status: 'ACTIVE', accountStatus: 'active', emailVerified: true, emailVerifiedAt: now, mustChangePassword: false,
    organizationId, pilotCohort: 'ga14-final-acceptance', pilotStartedAt: now,
    pilotExpiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000), pilotAccessStatus: 'ACTIVE',
    pilotCreatedByAdminId: admin.id, postPilotTier: 'BUSINESS',
  } });
  await prisma.organizationMember.create({ data: { organizationId, userId: user.id, role: 'OWNER', status: 'ACTIVE' } });

  const page = await browser.newPage();
  let bearer = '';
  page.on('request', (request: any) => {
    const authorization = request.headers()?.authorization;
    if (!bearer && typeof authorization === 'string' && authorization.startsWith('Bearer ')) bearer = authorization;
  });
  await page.goto(`${FRONTEND_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('input[type=email]', { timeout: 30000 });
  await page.type('input[type=email]', email);
  await page.type('input[type=password]', password);
  await page.click('button[type=submit]');
  await page.waitForFunction(() => location.pathname !== '/login' || Boolean(document.querySelector('[role="alert"]')), { timeout: 30000 });
  await page.goto(`${FRONTEND_URL}/startup/gap-analysis`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.body.innerText.includes('Gap Analysis'), { timeout: 30000 });
  if (!bearer) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => document.body.innerText.includes('Gap Analysis'), { timeout: 30000 });
  }
  if (!bearer) throw new Error('Authenticated browser session did not emit a bearer-authenticated API request.');
  return { page, userId: user.id, organizationId, authUserId: data.user.id, bearer };
}

async function snapshot(session: Session, tag: string): Promise<RaceSnapshot> {
  const analyses = await prisma.gapAnalysis.findMany({
    where: { userId: session.userId, documentName: { startsWith: tag } },
    select: { id: true, executionIdentity: true, status: true, documentUrl: true, reportUrl: true },
  });
  const analysisIds = analyses.map(({ id }) => id);
  const jobs = analysisIds.length === 0 ? [] : await prisma.aiJob.findMany({
    where: { type: 'GAP_ANALYSIS_PIPELINE', targetEntityType: 'GapAnalysis', targetEntityId: { in: analysisIds } },
    select: { id: true, status: true },
  });
  const storage = createStorageService();
  const sourceKeys = new Set(analyses.map(({ documentUrl }) => documentUrl).filter(Boolean));
  const sourceExistence = await Promise.all([...sourceKeys].map((key) => storage.fileExists(key)));
  const reportKeys = new Set(analyses.map(({ reportUrl }) => reportUrl).filter((value): value is string => Boolean(value)));
  const reportExistence = await Promise.all([...reportKeys].map((key) => storage.fileExists(key)));
  return {
    gapAnalysisCount: analyses.length,
    activeAnalysisCount: analyses.filter(({ status }) => ACTIVE_ANALYSIS_STATUSES.includes(status)).length,
    executionIdentities: [...new Set(analyses.map(({ executionIdentity }) => executionIdentity).filter((value): value is string => Boolean(value)))],
    statuses: analyses.map(({ status }) => status),
    aiJobCount: jobs.length,
    activeJobCount: jobs.filter(({ status }) => ACTIVE_JOB_STATUSES.includes(status)).length,
    usage: await readUsage(session.organizationId),
    sourceObjectCount: sourceExistence.filter(Boolean).length,
    reportObjectCount: reportExistence.filter(Boolean).length,
  };
}

function payload(tag: string, depth: 'quick' | 'standard' = 'quick', canary = false): RequestPayload {
  const text = canary
    ? `Controlled privacy test ${PRIVATE_CANARY}. This policy assigns data protection duties and incident response responsibilities.`
    : `GA-14 disposable policy ${tag}. The controller maintains access controls, retention rules, incident response, and data-subject request procedures.`;
  return {
    fileName: `${tag}.txt`, fileType: 'txt', fileContent: Buffer.from(text).toString('base64'),
    processingConsentAcknowledged: true, jurisdiction: 'KE', regulatoryFrameworks: ['Data Protection Act 2019'],
    analysisDepth: depth, focusAreas: [],
  };
}

function summarizeRace(results: ConcurrentResult[], before: RaceSnapshot, after: RaceSnapshot) {
  const successful = results.filter(({ ok }) => ok);
  const ids = [...new Set(successful.map(({ analysisId }) => analysisId).filter(Boolean))];
  return {
    requestCount: results.length,
    creatorCount: successful.filter(({ reused }) => reused === false).length,
    reusedCount: successful.filter(({ reused }) => reused === true).length,
    failedCount: results.filter(({ ok }) => !ok).length,
    uniqueAnalysisIds: ids.length,
    usageBefore: before.usage,
    usageAfter: after.usage,
    usageDelta: after.usage - before.usage,
    gapAnalysisCount: after.gapAnalysisCount - before.gapAnalysisCount,
    activeJobCount: after.activeJobCount - before.activeJobCount,
    sourceObjectCount: after.sourceObjectCount - before.sourceObjectCount,
    orphanObjectCount: Math.max(0, (after.sourceObjectCount - before.sourceObjectCount) - ids.length),
    durationMs: Math.max(...results.map(({ endedAt }) => endedAt)) - Math.min(...results.map(({ startedAt }) => startedAt)),
    errorCodes: [...new Set(results.map(({ errorCode }) => errorCode).filter(Boolean))],
  };
}

async function cleanupAnalyses(session: Session, ids: string[]): Promise<void> {
  for (const id of [...new Set(ids)]) {
    const first = await invokeMutation(session, 'gapAnalysis.deleteGapAnalysis', { id });
    if (first.status >= 400 && first.errorCode !== 'NOT_FOUND') throw new Error(`Supported cleanup failed for analysis ${id}.`);
    const second = await invokeMutation(session, 'gapAnalysis.deleteGapAnalysis', { id });
    if (second.status >= 400 && second.errorCode !== 'NOT_FOUND') throw new Error(`Idempotent cleanup failed for analysis ${id}.`);
  }
}

async function cleanupSession(session: Session): Promise<void> {
  await session.page.close().catch(() => undefined);
  await supabaseAdmin.auth.admin.deleteUser(session.authUserId).catch(() => undefined);
  await prisma.user.update({ where: { id: session.userId }, data: {
    status: 'SUSPENDED', accountStatus: 'suspended', email: `deleted_${session.userId}@sheriabot.internal`,
    supabaseAuthId: null, deletedAt: new Date(),
  } }).catch(() => undefined);
}

async function runRace(session: Session, tag: string, payloads: RequestPayload[]) {
  const before = await snapshot(session, tag);
  const results = await runConcurrentGapAnalysisRequests({ count: payloads.length, authenticatedSession: session, identicalOrDistinctPayloads: payloads });
  const after = await snapshot(session, tag);
  return { before, results, after, summary: summarizeRace(results, before, after) };
}

export async function runGa14PilotAcceptance(): Promise<void> {
  const targetSummary = assertDevelopmentUat();
  console.log(JSON.stringify({ gate: 'DEVELOPMENT-UAT TARGET GUARD', passed: true, ...targetSummary }));
  const browser = await puppeteer.launch({ executablePath: EDGE_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const sessions: Session[] = [];
  const allAnalysisIds: Array<{ session: Session; ids: string[] }> = [];
  let originalUsage: number | null = null;
  let sandboxOrgId = '';
  try {
    const org = await prisma.organization.findFirst({ where: { name: 'SheriaBot QA Batch 6.5 Sandbox' } }) ?? await prisma.organization.create({ data: {
      name: 'SheriaBot QA Batch 6.5 Sandbox', type: 'startup', organizationType: 'startup', subscriptionTier: 'BUSINESS',
      plan: 'BUSINESS', subscriptionStatus: 'ACTIVE', verificationStatus: 'verified', verifiedAt: new Date(), maxSeats: 20,
      homeJurisdictionCode: 'KE', enabledJurisdictions: ['KE'], needsCountryConfirmation: false,
    } });
    sandboxOrgId = org.id;
    await prisma.organization.update({ where: { id: org.id }, data: { plan: 'BUSINESS', subscriptionTier: 'BUSINESS', subscriptionStatus: 'ACTIVE', maxSeats: 20 } });
    originalUsage = await readUsage(org.id);

    const two = await provisionSession(browser, org.id, 'two-way'); sessions.push(two);
    const tag2 = `ga14-two-${Date.now()}`;
    const race2 = await runRace(two, tag2, Array.from({ length: 2 }, () => payload(tag2)));
    console.log(JSON.stringify({ gate: '2-WAY RACE', ...race2.summary }));
    allAnalysisIds.push({ session: two, ids: race2.results.map(({ analysisId }) => analysisId).filter((id): id is string => Boolean(id)) });

    const ten = await provisionSession(browser, org.id, 'ten-way'); sessions.push(ten);
    const tag10 = `ga14-ten-${Date.now()}`;
    const race10 = await runRace(ten, tag10, Array.from({ length: 10 }, () => payload(tag10)));
    console.log(JSON.stringify({ gate: '10-WAY RACE', ...race10.summary }));
    allAnalysisIds.push({ session: ten, ids: race10.results.map(({ analysisId }) => analysisId).filter((id): id is string => Boolean(id)) });

    const finalIdentical = await provisionSession(browser, org.id, 'final-identical'); sessions.push(finalIdentical);
    await setUsage(org.id, 59);
    const tagFi = `ga14-final-identical-${Date.now()}`;
    const raceFi = await runRace(finalIdentical, tagFi, Array.from({ length: 2 }, () => payload(tagFi)));
    console.log(JSON.stringify({ gate: 'FINAL-SLOT IDENTICAL', ...raceFi.summary }));
    allAnalysisIds.push({ session: finalIdentical, ids: raceFi.results.map(({ analysisId }) => analysisId).filter((id): id is string => Boolean(id)) });

    const finalDistinct = await provisionSession(browser, org.id, 'final-distinct'); sessions.push(finalDistinct);
    await setUsage(org.id, 59);
    const tagFd = `ga14-final-distinct-${Date.now()}`;
    const raceFd = await runRace(finalDistinct, tagFd, [payload(`${tagFd}-quick`, 'quick'), payload(`${tagFd}-standard`, 'standard')]);
    console.log(JSON.stringify({ gate: 'FINAL-SLOT DISTINCT', ...raceFd.summary }));
    allAnalysisIds.push({ session: finalDistinct, ids: raceFd.results.map(({ analysisId }) => analysisId).filter((id): id is string => Boolean(id)) });

    const canary = await provisionSession(browser, org.id, 'privacy'); sessions.push(canary);
    await setUsage(org.id, Math.min(originalUsage, 50));
    const tagCanary = `ga14-canary-${Date.now()}`;
    const canaryRace = await runRace(canary, tagCanary, [payload(tagCanary, 'quick', true)]);
    const canaryIds = canaryRace.results.map(({ analysisId }) => analysisId).filter((id): id is string => Boolean(id));
    allAnalysisIds.push({ session: canary, ids: canaryIds });
    const canaryJobs = canaryIds.length ? await prisma.aiJob.findMany({ where: { targetEntityId: { in: canaryIds } }, select: { payload: true, lastError: true } }) : [];
    const canaryRows = canaryIds.length ? await prisma.gapAnalysis.findMany({ where: { id: { in: canaryIds } }, select: { results: true, errorMessage: true, executionIdentityMetadata: true } }) : [];
    const durableCanaryLeak = JSON.stringify({ canaryJobs, canaryRows }).includes(PRIVATE_CANARY);
    console.log(JSON.stringify({ gate: 'PRIVACY CANARY DURABLE METADATA', passed: !durableCanaryLeak }));

    const report = { twoWay: race2.summary, tenWay: race10.summary, finalSlotIdentical: raceFi.summary, finalSlotDistinct: raceFd.summary, privacyCanaryDurableMetadata: !durableCanaryLeak };
    console.log(`GA14_ACCEPTANCE_RESULT=${JSON.stringify(report)}`);
  } finally {
    for (const owned of allAnalysisIds.reverse()) await cleanupAnalyses(owned.session, owned.ids).catch((error) => console.error(`Cleanup warning: ${error instanceof Error ? error.message : String(error)}`));
    if (sandboxOrgId && originalUsage !== null) await setUsage(sandboxOrgId, originalUsage).catch(() => undefined);
    for (const session of sessions.reverse()) await cleanupSession(session);
    await browser.close().catch(() => undefined);
  }
}

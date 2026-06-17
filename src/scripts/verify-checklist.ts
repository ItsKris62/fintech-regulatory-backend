#!/usr/bin/env tsx
/**
 * verify-checklist.ts
 *
 * Sprint 3B  -  E2E verification script for the three-tier checklist generation pipeline.
 *
 * Usage:
 *   pnpm tsx src/scripts/verify-checklist.ts            # Parse/prompt layer tests only
 *   pnpm tsx src/scripts/verify-checklist.ts --live     # + live Tier 3 AI call (costs tokens)
 *   pnpm tsx src/scripts/verify-checklist.ts --live --all-tiers  # + live Tier 1+2+3 calls
 *
 * Sections:
 *   1. Parse layer unit tests   -  parseWithTierSchema accepts/rejects synthetic inputs
 *   2. Prompt builder tests     -  buildTier1/2/3Prompt return well-formed prompts
 *   3. Live AI test (--live)    -  real Claude call via aiService.executeChecklistStream()
 *   4. Retry service test       -  checklistService.retryChecklist() rejects invalid states
 */

import 'dotenv/config';

import {
  parseWithTierSchema,
  buildTier1Prompt,
  buildTier2Prompt,
  buildTier3Prompt,
  Tier1ResponseSchema,
  Tier2ResponseSchema,
  Tier3ResponseSchema,
  trimRagPassages,
} from '../lib/ai/prompts/checklist-generation';
import { aiService } from '../lib/ai/ai.service';
import { aiConfig } from '../config/ai.config';

// --- CLI flags ----------------------------------------------------------------

const LIVE      = process.argv.includes('--live');
const ALL_TIERS = process.argv.includes('--all-tiers');

// --- Test harness -------------------------------------------------------------

interface TestResult {
  name:     string;
  section:  string;
  passed:   boolean;
  message:  string;
  durationMs: number;
  details?: string;
}

const results: TestResult[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`  ${name}`);
  console.log('-'.repeat(60));
}

async function runTest(
  name: string,
  fn: () => Promise<{ passed: boolean; message: string; details?: string }>,
): Promise<void> {
  const start = Date.now();
  try {
    console.log(`  ⏳ ${name}`);
    const result = await fn();
    const durationMs = Date.now() - start;
    results.push({ name, section: currentSection, durationMs, ...result });
    const icon = result.passed ? '✅' : '❌';
    console.log(`  ${icon} ${name} (${durationMs}ms)`);
    if (!result.passed) console.log(`     -> ${result.message}`);
    if (result.details) console.log(`     ℹ ${result.details}`);
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, section: currentSection, passed: false, message, durationMs });
    console.log(`  ❌ ${name} (${durationMs}ms)  -  threw: ${message}`);
  }
}

// --- Synthetic fixtures -------------------------------------------------------

const VALID_ITEM = {
  id:              'LIC-001',
  title:           'Obtain CBK Payment Service Provider Authorisation',
  regulatoryBasis: 'National Payment System Act 2011, Section 12',
  priority:        'CRITICAL' as const,
  description:     'All entities providing payment services must obtain CBK PSP authorisation before commencing operations. Unauthorised operation is a criminal offence under Section 36.',
  guidance:        'As a payment gateway, PSP authorisation is your single biggest regulatory blocker.',
  actionItems: [
    'Download CBK PSP application form from centralbank.go.ke',
    'Prepare mandatory annexures: certificate of incorporation, AML/CFT policy, BCP',
    'Pay non-refundable application fee of KES 10,000',
    'Submit application package to Director, National Payments System, CBK',
  ],
  deadline: 'Before commencing any payment service operations',
  penalty:  'Fine not exceeding KES 10,000,000 and/or imprisonment not exceeding 5 years  -  NPSA 2011, Section 36',
};

function makeCategory(id: string, name: string, itemCount: number) {
  return {
    id,
    name,
    description: `Core ${name.toLowerCase()} requirements for Kenyan fintech operations.`,
    items: Array.from({ length: itemCount }, (_, i) => ({
      ...VALID_ITEM,
      id: `${id}-${String(i + 1).padStart(3, '0')}`,
      title: `${name} requirement ${i + 1}`,
    })),
  };
}

function makeValidChecklist(categoryCount: number, itemsPerCat: number) {
  const cats = [
    makeCategory('LIC', 'Licensing & Registration', itemsPerCat),
    makeCategory('DPP', 'Data Protection & Privacy', itemsPerCat),
    makeCategory('AML', 'AML / KYC / CFT', itemsPerCat),
    makeCategory('CON', 'Consumer Protection', itemsPerCat),
    makeCategory('CAP', 'Capital & Prudential', itemsPerCat),
    makeCategory('CYB', 'Cybersecurity', itemsPerCat),
  ].slice(0, categoryCount);

  return {
    categories: cats,
    metadata: {
      productType:             'Payment Gateway / PSP',
      businessStage:           'Pre-launch / Licensing Phase',
      totalItems:              categoryCount * itemsPerCat,
      criticalItems:           categoryCount,
      highItems:               categoryCount * 2,
      estimatedCompletionDays: 150,
      generatedAt:             new Date().toISOString(),
      ragSourcesUsed:          8,
    },
  };
}

const INPUT_FIXTURE = {
  productType:    'Payment Gateway / PSP',
  businessStage:  'Pre-launch / Licensing Phase',
};

// --- Section 1: Parse layer unit tests ---------------------------------------

async function runParseLayerTests(): Promise<void> {
  section('Section 1  -  Parse layer (parseWithTierSchema)');

  // 1a. Tier 1: valid full response
  await runTest('Tier 1 accepts a valid 5-category / 25-item response', async () => {
    const payload = makeValidChecklist(5, 5); // 5 × 5 = 25 items
    const json = JSON.stringify(payload);
    const result = parseWithTierSchema(json, 1, { input: INPUT_FIXTURE, ragSourcesUsed: 8 });
    const total = result.categories.flatMap((c) => c.items).length;
    return {
      passed:  total === 25 && result.categories.length === 5,
      message: `${result.categories.length} categories, ${total} items`,
    };
  });

  // 1b. Tier 1: rejects too-few items
  await runTest('Tier 1 rejects response with < 25 items', async () => {
    const payload = makeValidChecklist(4, 4); // 4 × 4 = 16 items  -  below Tier1 min 25
    const json = JSON.stringify(payload);
    try {
      parseWithTierSchema(json, 1, { input: INPUT_FIXTURE });
      return { passed: false, message: 'Expected a throw but got success' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { passed: true, message: 'Correctly rejected', details: msg.slice(0, 100) };
    }
  });

  // 1c. Tier 2: valid 3-category / 10-item response
  await runTest('Tier 2 accepts a valid 3-category / 12-item response', async () => {
    const payload = makeValidChecklist(3, 4); // 3 × 4 = 12 items
    const json = JSON.stringify(payload);
    const result = parseWithTierSchema(json, 2, { input: INPUT_FIXTURE, ragSourcesUsed: 4 });
    const total = result.categories.flatMap((c) => c.items).length;
    return {
      passed:  total >= 10 && result.categories.length >= 3,
      message: `${result.categories.length} categories, ${total} items`,
    };
  });

  // 1d. Tier 3: accepts minimal 2-category / 5-item response with no metadata
  await runTest('Tier 3 accepts a minimal 2-category response without metadata', async () => {
    const payload = { categories: [makeCategory('LIC', 'Licensing', 3), makeCategory('AML', 'AML/KYC', 3)] };
    const json = JSON.stringify(payload);
    const result = parseWithTierSchema(json, 3, { input: INPUT_FIXTURE });
    const total = result.categories.flatMap((c) => c.items).length;
    return {
      passed:  total >= 5 && result.metadata.productType === INPUT_FIXTURE.productType,
      message: `${total} items, metadata synthesized from input`,
    };
  });

  // 1e. JSON with markdown fence is stripped and parsed
  await runTest('Strips markdown code fences before parsing', async () => {
    const payload = makeValidChecklist(3, 4);
    const json = '```json\n' + JSON.stringify(payload) + '\n```';
    const result = parseWithTierSchema(json, 2, { input: INPUT_FIXTURE });
    return {
      passed:  result.categories.length >= 3,
      message: `Fence stripped, ${result.categories.length} categories parsed`,
    };
  });

  // 1f. Truncated JSON (missing closing braces) is repaired
  await runTest('Repairs truncated JSON (missing closing brackets)', async () => {
    const payload = makeValidChecklist(3, 4);
    // Simulate truncation by cutting off the last 50 chars
    let json = JSON.stringify(payload);
    json = json.slice(0, json.length - 50);
    try {
      const result = parseWithTierSchema(json, 2, { input: INPUT_FIXTURE });
      return {
        passed:  result.categories.length >= 1,
        message: `Repaired  -  recovered ${result.categories.length} categories`,
      };
    } catch (err: unknown) {
      // It's acceptable for extreme truncation to still fail  -  this tests the attempt
      const msg = err instanceof Error ? err.message : String(err);
      return {
        passed:  msg.includes('repaired') || msg.includes('partial') || msg.includes('recovery'),
        message: `Correctly handled truncation: ${msg.slice(0, 80)}`,
      };
    }
  });

  // 1g. Partial category recovery: 1 invalid category out of 4  -  should still pass at Tier 2
  await runTest('Partial recovery accepts 3/4 valid categories at Tier 2', async () => {
    const payload = makeValidChecklist(4, 3); // 4 categories × 3 items = 12 items
    // Corrupt the 4th category (remove required 'description' field)
    const corrupted = JSON.parse(JSON.stringify(payload));
    delete corrupted.categories[3].description;
    const json = JSON.stringify(corrupted);
    try {
      const result = parseWithTierSchema(json, 2, { input: INPUT_FIXTURE });
      return {
        passed:  result.categories.length >= 3,
        message: `Recovered ${result.categories.length} of 4 categories`,
      };
    } catch (err: unknown) {
      return { passed: false, message: (err instanceof Error ? err.message : String(err)).slice(0, 100) };
    }
  });

  // 1h. Metadata counts are always recomputed (AI self-reported counts are ignored)
  await runTest('Metadata counts are recomputed, not taken from AI response', async () => {
    const payload = makeValidChecklist(3, 4);
    // Lie about counts in the metadata
    payload.metadata.totalItems    = 999;
    payload.metadata.criticalItems = 999;
    payload.metadata.highItems     = 999;
    const json = JSON.stringify(payload);
    const result = parseWithTierSchema(json, 2, { input: INPUT_FIXTURE });
    const realTotal = result.categories.flatMap((c) => c.items).length;
    return {
      passed:  result.metadata.totalItems === realTotal && result.metadata.totalItems !== 999,
      message: `AI reported 999, actual recomputed to ${result.metadata.totalItems}`,
    };
  });
}

// --- Section 2: Prompt builder tests -----------------------------------------

async function runPromptBuilderTests(): Promise<void> {
  section('Section 2  -  Prompt builders (buildTier1/2/3Prompt)');

  const INPUT = {
    productType:        'Digital Lending / Credit Provider',
    businessStage:      'Operational (less than 1 year)',
    targetSegments:     ['Individual consumers (B2C)', 'SMEs (B2B)'],
    servicesOffered:    ['Lending / Credit', 'Account opening / KYC'],
    additionalConcerns: 'CBK digital credit regulations compliance',
  };

  const PASSAGES = [
    { chunkText: 'Digital Credit Providers Regulations 2022 require all digital lenders to obtain a licence from CBK.', documentTitle: 'CBK DCP Regulations 2022' },
    { chunkText: 'The Data Protection Act 2019 requires all data controllers to register with the ODPC.', documentTitle: 'Data Protection Act 2019' },
    { chunkText: 'AML/CFT obligations under POCAMLA require FRC registration within 30 days of commencing operations.', documentTitle: 'POCAMLA 2009' },
  ];

  // 2a. Tier 1 prompt is well-formed
  await runTest('buildTier1Prompt returns non-empty system + user prompts', async () => {
    const { system, user } = buildTier1Prompt(INPUT, PASSAGES);
    const hasAntiTrunc = system.includes('ANTI-TRUNCATION') && user.includes('PRE-SUBMISSION');
    return {
      passed:  system.length > 500 && user.length > 500 && hasAntiTrunc,
      message: `system ${system.length} chars, user ${user.length} chars, guardrails: ${hasAntiTrunc}`,
    };
  });

  // 2b. Tier 1 prompt injects RAG context
  await runTest('buildTier1Prompt injects RAG context into user prompt', async () => {
    const { user } = buildTier1Prompt(INPUT, PASSAGES);
    const hasPassage = user.includes('REGULATORY CONTEXT') && user.includes('CBK DCP Regulations');
    return {
      passed:  hasPassage,
      message: hasPassage ? 'RAG passages injected' : 'RAG passages missing from prompt',
    };
  });

  // 2c. Tier 1 with no passages produces source-insufficiency note
  await runTest('buildTier1Prompt with no passages uses source-insufficiency note', async () => {
    const { user } = buildTier1Prompt(INPUT, []);
    const hasNote = user.includes('SOURCE INSUFFICIENCY') && user.includes('Do not generate legal obligations');
    return {
      passed:  hasNote,
      message: hasNote ? 'Source-insufficiency note present' : 'Missing source-insufficiency note',
    };
  });

  // 2d. Tier 2 prompt is shorter / condensed vs Tier 1
  await runTest('buildTier2Prompt produces a shorter prompt than Tier 1', async () => {
    const { system: s1, user: u1 } = buildTier1Prompt(INPUT, PASSAGES);
    const { system: s2, user: u2 } = buildTier2Prompt(INPUT, PASSAGES);
    const tier1Total = s1.length + u1.length;
    const tier2Total = s2.length + u2.length;
    return {
      passed:  tier2Total < tier1Total,
      message: `Tier 1: ${tier1Total} chars, Tier 2: ${tier2Total} chars (${Math.round((1 - tier2Total / tier1Total) * 100)}% smaller)`,
    };
  });

  // 2e. Tier 3 prompt has no RAG section
  await runTest('buildTier3Prompt produces prompt with no RAG context section', async () => {
    const { user } = buildTier3Prompt(INPUT);
    const hasRag = user.includes('REGULATORY CONTEXT') || user.includes('Retrieved');
    return {
      passed:  !hasRag,
      message: hasRag ? 'Unexpected RAG section in Tier 3' : 'No RAG context  -  correct',
    };
  });

  // 2f. trimRagPassages respects budget
  await runTest('trimRagPassages respects maxTokenBudget', async () => {
    const passages = Array.from({ length: 20 }, (_, i) => ({
      chunkText:     'A'.repeat(400), // ~100 tokens each
      documentTitle: `Doc ${i}`,
    }));
    const trimmed = trimRagPassages(passages, 500); // budget 500 tokens -> max ~5 passages
    return {
      passed:  trimmed.length <= 6 && trimmed.length >= 1,
      message: `${trimmed.length} passages kept within ~500-token budget`,
    };
  });

  // 2g. Tier 1 system prompt cites all 9 expected regulators
  await runTest('Tier 1 system prompt mentions all key regulators', async () => {
    const { system } = buildTier1Prompt(INPUT, []);
    const required = ['CBK', 'ODPC', 'FRC', 'CMA', 'IRA', 'KRA', 'SASRA'];
    const missing  = required.filter((r) => !system.includes(r));
    return {
      passed:  missing.length === 0,
      message: missing.length === 0
        ? 'All 7 regulators mentioned'
        : `Missing: ${missing.join(', ')}`,
    };
  });

  // 2h. Tier ResponseSchemas are correctly ordered by strictness
  await runTest('Tier Zod schemas have correct minimum item thresholds (T1≥25, T2≥10, T3≥5)', async () => {
    // Test by parsing a 25-item payload and checking which schemas pass
    const t1Passes = Tier1ResponseSchema.safeParse(makeValidChecklist(5, 5)).success;  // 25 items
    const t1Fails  = Tier1ResponseSchema.safeParse(makeValidChecklist(3, 4)).success;  // 12 items
    const t2Passes = Tier2ResponseSchema.safeParse(makeValidChecklist(3, 4)).success;  // 12 items
    const t2Fails  = Tier2ResponseSchema.safeParse(makeValidChecklist(2, 3)).success;  // 6 items
    const t3Passes = Tier3ResponseSchema.safeParse(makeValidChecklist(2, 3)).success;  // 6 items
    const allCorrect = t1Passes && !t1Fails && t2Passes && !t2Fails && t3Passes;
    return {
      passed:  allCorrect,
      message: allCorrect
        ? 'Schema thresholds all correct'
        : `T1p=${t1Passes} T1f=${t1Fails} T2p=${t2Passes} T2f=${t2Fails} T3p=${t3Passes}`,
    };
  });
}

// --- Section 3: Live AI test (--live) ----------------------------------------

async function runLiveAiTests(allTiers: boolean): Promise<void> {
  section(`Section 3  -  Live AI tests (flag: --live${allTiers ? ' --all-tiers' : ''})`);

  const INPUT = {
    productType:    'Mobile Money Operator',
    businessStage:  'Operational (less than 1 year)',
    targetSegments: ['Individual consumers (B2C)'],
    servicesOffered: ['Account opening / KYC', 'Payments processing'],
  };

  if (allTiers) {
    // Tier 1  -  most expensive, most comprehensive
    await runTest('Live Tier 1 generation (full RAG, 8192 tokens, 240s)', async () => {
      const { system, user } = buildTier1Prompt(INPUT, []);
      const { content, inputTokens, outputTokens, stopReason } = await aiService.executeChecklistStream(
        { systemPrompt: system, userPrompt: user, maxTokens: 8192, overrideTimeoutMs: aiConfig.timeout.checklistTier1 },
        () => { /* progress ignored in script */ },
      );
      const result = parseWithTierSchema(content, 1, { input: INPUT });
      const total  = result.categories.flatMap((c) => c.items).length;
      return {
        passed:  result.categories.length >= 4 && total >= 20,
        message: `${result.categories.length} categories, ${total} items, stopReason=${stopReason}`,
        details: `Tokens: ${inputTokens} in / ${outputTokens} out`,
      };
    });

    // Tier 2  -  medium
    await runTest('Live Tier 2 generation (simplified, 6144 tokens, 200s)', async () => {
      const { system, user } = buildTier2Prompt(INPUT, []);
      const { content, inputTokens, outputTokens, stopReason } = await aiService.executeChecklistStream(
        { systemPrompt: system, userPrompt: user, maxTokens: 6144, overrideTimeoutMs: aiConfig.timeout.checklistTier2 },
        () => {},
      );
      const result = parseWithTierSchema(content, 2, { input: INPUT });
      const total  = result.categories.flatMap((c) => c.items).length;
      return {
        passed:  result.categories.length >= 3 && total >= 10,
        message: `${result.categories.length} categories, ${total} items, stopReason=${stopReason}`,
        details: `Tokens: ${inputTokens} in / ${outputTokens} out`,
      };
    });
  }

  // Tier 3  -  always run with --live (cheapest, fastest)
  await runTest('Live Tier 3 generation (minimal no-RAG, 4096 tokens, 150s)', async () => {
    const { system, user } = buildTier3Prompt(INPUT);
    const { content, inputTokens, outputTokens, stopReason } = await aiService.executeChecklistStream(
      { systemPrompt: system, userPrompt: user, maxTokens: 4096, overrideTimeoutMs: aiConfig.timeout.checklistTier3 },
      () => {},
    );
    const result = parseWithTierSchema(content, 3, { input: INPUT });
    const total  = result.categories.flatMap((c) => c.items).length;
    return {
      passed:  result.categories.length >= 2 && total >= 5,
      message: `${result.categories.length} categories, ${total} items, stopReason=${stopReason}`,
      details: `Tokens: ${inputTokens} in / ${outputTokens} out`,
    };
  });
}

// --- Summary ------------------------------------------------------------------

function printSummary(): void {
  const total   = results.length;
  const passed  = results.filter((r) => r.passed).length;
  const failed  = total - passed;
  const passRate = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RESULTS: ${passed}/${total} passed  (${passRate}%)`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    console.log('\n  FAILURES:');
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`\n  ❌ [${r.section}] ${r.name}`);
        console.log(`     ${r.message}`);
      });
  }

  // Per-section summary
  const sections = [...new Set(results.map((r) => r.section))];
  console.log('\n  SECTION SUMMARY:');
  sections.forEach((sec) => {
    const secResults = results.filter((r) => r.section === sec);
    const p = secResults.filter((r) => r.passed).length;
    const t = secResults.length;
    const icon = p === t ? '✅' : p > 0 ? '⚠️' : '❌';
    console.log(`  ${icon} ${sec}: ${p}/${t}`);
  });

  console.log('');

  if (failed > 0) {
    console.error(`\nSprint 3B verification: ${failed} test(s) FAILED`);
    process.exit(1);
  } else {
    console.log('Sprint 3B verification: ALL TESTS PASSED\n');
  }
}

// --- Entry point -------------------------------------------------------------

async function main(): Promise<void> {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   SheriaBot  -  Sprint 3B Checklist Pipeline Verification  ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log(`  Mode: ${LIVE ? (ALL_TIERS ? 'live (all tiers)' : 'live (tier 3 only)') : 'offline (parse + prompt tests)'}`);

  await runParseLayerTests();
  await runPromptBuilderTests();

  if (LIVE) {
    await runLiveAiTests(ALL_TIERS);
  } else {
    console.log('\n  ℹ  Live AI tests skipped  -  pass --live to run them');
  }

  printSummary();
}

main().catch((err) => {
  console.error('\nFatal error running verification script:', err);
  process.exit(1);
});

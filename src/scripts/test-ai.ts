#!/usr/bin/env tsx

/**
 * AI Service Test Script
 * Tests Anthropic Claude integration and prompt templates
 */

import { aiService } from '../lib/ai/ai.service';
import { complete, getAIStats } from '../lib/ai/client';
import { aiConfig } from '../config/ai.config';
import * as fs from 'fs';
import * as path from 'path';

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  duration?: number;
  cost?: number;
}

const results: TestResult[] = [];

/**
 * Run a test and record result
 */
async function runTest(
  name: string,
  testFn: () => Promise<{ success: boolean; message: string; cost?: number }>
): Promise<void> {
  const startTime = Date.now();

  try {
    console.log(`\n🧪 ${name}...`);
    const result = await testFn();
    const duration = Date.now() - startTime;

    results.push({
      name,
      success: result.success,
      message: result.message,
      duration,
      cost: result.cost,
    });

    if (result.success) {
      console.log(`   ✅ ${result.message} (${duration}ms${result.cost ? `, $${result.cost.toFixed(4)}` : ''})`);
    } else {
      console.log(`   ❌ ${result.message} (${duration}ms)`);
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;

    results.push({
      name,
      success: false,
      message: error.message,
      duration,
    });

    console.log(`   ❌ Error: ${error.message} (${duration}ms)`);
  }
}

/**
 * Test 1: Check configuration
 */
async function testConfiguration() {
  return runTest('AI Configuration', async () => {
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

    if (!hasApiKey) {
      return {
        success: false,
        message: 'ANTHROPIC_API_KEY not configured',
      };
    }

    return {
      success: true,
      message: `API key configured, model: ${aiConfig.models.complianceQuery}`,
    };
  });
}

/**
 * Test 2: Basic AI completion
 */
async function testBasicCompletion() {
  return runTest('Basic AI Completion', async () => {
    const result = await complete({
      prompt: 'What is the capital of Kenya?',
      systemPrompt: 'You are a helpful assistant.',
      maxTokens: 100,
    });

    if (!result.content || !result.content.toLowerCase().includes('nairobi')) {
      return {
        success: false,
        message: 'Unexpected response',
      };
    }

    return {
      success: true,
      message: `Response received (${result.inputTokens} + ${result.outputTokens} tokens)`,
      cost: result.cost,
    };
  });
}

/**
 * Test 3: Compliance query
 */
async function testComplianceQuery() {
  return runTest('Compliance Query', async () => {
    const result = await aiService.answerComplianceQuery({
      question: 'What are the KYC requirements for digital lending apps in Kenya?',
      organizationType: 'FINTECH',
      industry: 'Digital Lending',
    });

    // Save response for review
    const outputDir = path.join(process.cwd(), 'ai-test-outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    fs.writeFileSync(
      path.join(outputDir, 'compliance-query.txt'),
      `QUESTION: What are the KYC requirements for digital lending apps in Kenya?\n\n` +
      `ANSWER:\n${result.content}\n\n` +
      `CITATIONS: ${result.sections.citations.join(', ')}\n\n` +
      `COST: $${result.cost.toFixed(4)}\n` +
      `TOKENS: ${result.inputTokens} in, ${result.outputTokens} out`
    );

    if (!result.sections.directAnswer || result.sections.citations.length === 0) {
      return {
        success: false,
        message: 'Response missing expected sections or citations',
      };
    }

    return {
      success: true,
      message: `Query answered with ${result.sections.citations.length} citations (saved to ai-test-outputs/)`,
      cost: result.cost,
    };
  });
}

/**
 * Test 4: Policy generation (short scenario)
 */
async function testPolicyGeneration() {
  return runTest('Policy Generation', async () => {
    const result = await aiService.generatePolicy({
      scenario: 'A mobile money provider wants to launch a savings product that allows customers to save money and earn interest.',
      organizationType: 'FINTECH',
      regulatoryAreas: ['Digital Payments', 'Data Protection', 'Consumer Protection'],
      specificRequirements: 'Must comply with CBK regulations and ODPC data protection requirements',
    });

    // Save response for review
    const outputDir = path.join(process.cwd(), 'ai-test-outputs');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    fs.writeFileSync(
      path.join(outputDir, 'policy-generation.txt'),
      `SCENARIO: Mobile money savings product\n\n` +
      `EXECUTIVE SUMMARY:\n${result.sections.executiveSummary}\n\n` +
      `REGULATORY LANDSCAPE:\n${result.sections.regulatoryLandscape}\n\n` +
      `RECOMMENDATIONS:\n${result.sections.recommendations}\n\n` +
      `CITATIONS: ${result.sections.citations.join(', ')}\n\n` +
      `FOLLOW-UP QUESTIONS:\n${result.followUpQuestions?.join('\n')}\n\n` +
      `COST: $${result.cost.toFixed(4)}\n` +
      `TOKENS: ${result.inputTokens} in, ${result.outputTokens} out`
    );

    if (!result.sections.executiveSummary || result.sections.citations.length === 0) {
      return {
        success: false,
        message: 'Policy missing expected sections or citations',
      };
    }

    return {
      success: true,
      message: `Policy generated with ${result.sections.citations.length} citations (saved to ai-test-outputs/)`,
      cost: result.cost,
    };
  });
}

/**
 * Test 5: Quick compliance check
 */
async function testQuickCheck() {
  return runTest('Quick Compliance Check', async () => {
    const result = await aiService.quickComplianceCheck(
      'We collect user phone numbers and national IDs for account verification. Is this compliant with Kenyan data protection laws?'
    );

    // Save response
    const outputDir = path.join(process.cwd(), 'ai-test-outputs');
    fs.writeFileSync(
      path.join(outputDir, 'quick-check.txt'),
      `SCENARIO: Phone numbers and national IDs collection\n\n` +
      `RESPONSE:\n${result.content}\n\n` +
      `COST: $${result.cost.toFixed(4)}`
    );

    if (!result.content) {
      return {
        success: false,
        message: 'No response received',
      };
    }

    return {
      success: true,
      message: `Quick check completed (saved to ai-test-outputs/)`,
      cost: result.cost,
    };
  });
}

/**
 * Test 6: Citation verification
 */
async function testCitationVerification() {
  return runTest('Citation Verification', async () => {
    const citations = [
      'Data Protection Act 2019, Section 25(1)',
      'CBK Prudential Guidelines 2013, Clause 4.2',
      'National Payment Systems Act 2011',
      'Fake Act 2024, Section 99', // This should be flagged as incorrect
    ];

    const result = await aiService.verifyCitations(citations);

    // Save response
    const outputDir = path.join(process.cwd(), 'ai-test-outputs');
    fs.writeFileSync(
      path.join(outputDir, 'citation-verification.txt'),
      `CITATIONS TO VERIFY:\n${citations.join('\n')}\n\n` +
      `VERIFICATION RESULTS:\n${result.content}\n\n` +
      `COST: $${result.cost.toFixed(4)}`
    );

    if (!result.content) {
      return {
        success: false,
        message: 'No verification response',
      };
    }

    return {
      success: true,
      message: `Citations verified (saved to ai-test-outputs/)`,
      cost: result.cost,
    };
  });
}

/**
 * Test 7: Cost tracking
 */
async function testCostTracking() {
  return runTest('Cost Tracking', async () => {
    const stats = await getAIStats();

    return {
      success: true,
      message: `Daily cost: $${stats.todayCost.toFixed(4)} / $${stats.dailyLimit} (${stats.percentUsed.toFixed(1)}% used)`,
    };
  });
}

/**
 * Test 8: Cache functionality
 */
async function testCaching() {
  return runTest('Response Caching', async () => {
    const prompt = 'What is the Kenya Revenue Authority PIN format?';

    // First request (should not be cached)
    const result1 = await complete({
      prompt,
      systemPrompt: 'You are a helpful assistant.',
      maxTokens: 200,
    }, 'query', 3600); // Cache for 1 hour

    // Second request (should be cached)
    const result2 = await complete({
      prompt,
      systemPrompt: 'You are a helpful assistant.',
      maxTokens: 200,
    }, 'query', 3600);

    if (!result2.cached) {
      return {
        success: false,
        message: 'Second request was not cached',
      };
    }

    return {
      success: true,
      message: 'Cache working correctly',
      cost: result1.cost, // Only first request costs money
    };
  });
}

/**
 * Print summary
 */
function printSummary() {
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  const total = results.length;

  console.log(`\nTotal Tests: ${total}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);

  if (failed > 0) {
    console.log('\n⚠️  Failed Tests:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`   - ${r.name}: ${r.message}`);
      });
  }

  const totalCost = results.reduce((sum, r) => sum + (r.cost || 0), 0);
  const avgDuration = results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length;

  console.log(`\n💰 Total cost: $${totalCost.toFixed(4)}`);
  console.log(`⏱️  Average test duration: ${avgDuration.toFixed(0)}ms`);

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('🎉 All tests passed! AI service is ready to use.');
    console.log('\n📁 Test outputs saved to: ai-test-outputs/');
  } else {
    console.log('⚠️  Some tests failed. Please check configuration.');
  }

  console.log('\n💡 To run a specific test type:');
  console.log('   tsx scripts/test-ai.ts policy');
  console.log('   tsx scripts/test-ai.ts query');
  console.log('   tsx scripts/test-ai.ts quick');
}

/**
 * Main execution
 */
async function main() {
  console.log('🧪 SheriaBot AI Service Test');
  console.log('='.repeat(60));
  console.log(`Model: ${aiConfig.models.complianceQuery}`);
  console.log(`Daily Limit: $${aiConfig.costs.dailyLimit}`);
  console.log('='.repeat(60));

  const testType = process.argv[2];

  try {
    await testConfiguration();

    if (!testType || testType === 'all') {
      await testBasicCompletion();
      await testComplianceQuery();
      await testPolicyGeneration();
      await testQuickCheck();
      await testCitationVerification();
      await testCostTracking();
      await testCaching();
    } else if (testType === 'policy') {
      await testPolicyGeneration();
      await testCitationVerification();
    } else if (testType === 'query') {
      await testComplianceQuery();
      await testQuickCheck();
    } else if (testType === 'quick') {
      await testQuickCheck();
    } else if (testType === 'basic') {
      await testBasicCompletion();
      await testCaching();
    }

    await testCostTracking();

    printSummary();

    process.exit(results.some((r) => !r.success) ? 1 : 0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
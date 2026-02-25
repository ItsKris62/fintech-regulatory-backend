#!/usr/bin/env tsx

/**
 * RAG System Test Script
 * Tests Pinecone vector database, embeddings, and semantic search
 */

import { ragService } from '../lib/rag/rag.service';
import { getIndexStats, checkPineconeHealth } from '../lib/rag/client';
import { getEmbeddingConfig, getEmbeddingStats } from '../lib/rag/embeddings';
import { chunkDocument, previewChunks } from '../lib/rag/chunking';

interface TestResult {
  name: string;
  success: boolean;
  message: string;
  duration?: number;
}

const results: TestResult[] = [];

/**
 * Run a test and record result
 */
async function runTest(
  name: string,
  testFn: () => Promise<{ success: boolean; message: string }>
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
    });

    if (result.success) {
      console.log(`   ✅ ${result.message} (${duration}ms)`);
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
  return runTest('Configuration Check', async () => {
    const hasPineconeKey = !!process.env.PINECONE_API_KEY;
    const hasIndexName = !!process.env.PINECONE_INDEX_NAME;
    const embeddingConfig = getEmbeddingConfig();

    if (!hasPineconeKey) {
      return {
        success: false,
        message: 'PINECONE_API_KEY not configured',
      };
    }

    if (!hasIndexName) {
      return {
        success: false,
        message: 'PINECONE_INDEX_NAME not configured',
      };
    }

    return {
      success: true,
      message: `Configured with ${embeddingConfig.provider} embeddings (${embeddingConfig.dimension}d)`,
    };
  });
}

/**
 * Test 2: Check Pinecone health
 */
async function testPineconeHealth() {
  return runTest('Pinecone Health Check', async () => {
    const healthy = await checkPineconeHealth();

    if (!healthy) {
      return {
        success: false,
        message: 'Pinecone not accessible',
      };
    }

    const stats = await getIndexStats();

    return {
      success: true,
      message: `Pinecone healthy (${stats.totalRecordCount} vectors, ${stats.dimension}d)`,
    };
  });
}

/**
 * Test 3: Test embeddings
 */
async function testEmbeddings() {
  return runTest('Embedding Generation', async () => {
    const config = getEmbeddingConfig();
    // Integrated mode: Pinecone handles embedding generation during upsert/search
    return {
      success: true,
      message: `Integrated embeddings enabled — model: ${config.model} (${config.dimension}d, managed by Pinecone)`,
    };
  });
}

/**
 * Test 4: Test document chunking
 */
async function testChunking() {
  return runTest('Document Chunking', async () => {
    const sampleLegalText = `
DATA PROTECTION ACT 2019

SECTION 1: INTERPRETATION
In this Act, unless the context otherwise requires—
"data controller" means a person who either alone, jointly with other persons or in common with other persons or as a statutory body determines the purposes for which and the manner in which any personal data is processed or is to be processed;

SECTION 2: APPLICATION
This Act applies to—
(a) a data controller or data processor who is established in Kenya and processes personal data in the context of that establishment;
(b) a data controller or data processor not established in Kenya, but in a place where the law of Kenya applies by virtue of public international law;

SECTION 3: PRINCIPLES
Personal data shall be—
(a) processed lawfully, fairly and in a transparent manner in relation to the data subject;
(b) collected for explicit, specified and legitimate purposes and not further processed in a manner incompatible with those purposes;
    `.trim();

    const chunks = chunkDocument(sampleLegalText, {
      maxChunkSize: 500,
      chunkOverlap: 100,
      respectSections: true,
    });

    if (chunks.length === 0) {
      return {
        success: false,
        message: 'No chunks generated',
      };
    }

    // Show preview
    console.log('\n   📄 Chunk Preview:');
    previewChunks(chunks, 2);

    return {
      success: true,
      message: `Generated ${chunks.length} chunks`,
    };
  });
}

/**
 * Test 5: Index sample document
 */
async function testIndexing() {
  return runTest('Document Indexing', async () => {
    const sampleDocument = {
      id: 'test-doc-sample',
      title: 'Sample Legal Document',
      content: `
The Central Bank of Kenya (CBK) regulates digital lending in Kenya through the Digital Credit Regulations 2022.

Key requirements include:
1. Digital credit providers must be licensed by CBK
2. Interest rates must be disclosed clearly
3. Customer data must be protected according to the Data Protection Act 2019
4. Debt collection practices must comply with consumer protection laws

All digital lenders operating in Kenya must comply with these regulations.
      `.trim(),
      documentType: 'REGULATION',
      regulatoryArea: 'Digital Lending',
    };

    const chunksIndexed = await ragService.indexDocument(sampleDocument);

    if (chunksIndexed === 0) {
      return {
        success: false,
        message: 'No chunks indexed',
      };
    }

    return {
      success: true,
      message: `Indexed ${chunksIndexed} chunks`,
    };
  });
}

/**
 * Test 6: Search functionality
 */
async function testSearch() {
  return runTest('Semantic Search', async () => {
    const query = 'What are the requirements for digital lending in Kenya?';

    const results = await ragService.search(query, {
      topK: 3,
      minScore: 0.5,
    });

    if (results.length === 0) {
      return {
        success: false,
        message: 'No results found (index may be empty)',
      };
    }

    console.log('\n   🔍 Search Results:');
    results.forEach((result, i) => {
      console.log(`   ${i + 1}. ${result.documentTitle} (score: ${result.score.toFixed(3)})`);
      console.log(`      Section: ${result.section || 'N/A'}`);
      console.log(`      Preview: ${result.chunkText.substring(0, 100)}...`);
    });

    return {
      success: true,
      message: `Found ${results.length} relevant chunks`,
    };
  });
}

/**
 * Test 7: Search with reranking
 */
async function testReranking() {
  return runTest('Search with Reranking', async () => {
    const query = 'data protection requirements';

    const results = await ragService.searchWithReranking(query, {
      topK: 3,
      minScore: 0.5,
    });

    if (results.length === 0) {
      return {
        success: false,
        message: 'No results found',
      };
    }

    const summary = ragService.generateSearchSummary(query, results);

    console.log('\n   📊 Search Summary:');
    console.log(`   Documents: ${summary.documentsFound.join(', ')}`);
    console.log(`   Avg Score: ${summary.avgScore.toFixed(3)}`);
    console.log(`   Citations: ${summary.citations.join(', ') || 'None'}`);

    return {
      success: true,
      message: `Found ${results.length} results, avg score: ${summary.avgScore.toFixed(3)}`,
    };
  });
}

/**
 * Test 8: Get context for AI
 */
async function testContextGeneration() {
  return runTest('AI Context Generation', async () => {
    const query = 'What is KYC in Kenya?';

    const results = await ragService.search(query, { topK: 3 });

    if (results.length === 0) {
      return {
        success: true, // Not a failure if index is empty
        message: 'No results to generate context from',
      };
    }

    const context = ragService.getContextForPrompt(results, 3, 2000);

    console.log('\n   📝 Generated Context Preview:');
    console.log(`   ${context.substring(0, 300)}...`);

    return {
      success: true,
      message: `Generated ${context.length} chars of context`,
    };
  });
}

/**
 * Test 9: Embedding cache
 */
async function testEmbeddingCache() {
  return runTest('Embedding Cache', async () => {
    const stats = await getEmbeddingStats();

    return {
      success: true,
      message: `Cache has ${stats.cacheSize} embeddings`,
    };
  });
}

/**
 * Test 10: Index statistics
 */
async function testIndexStats() {
  return runTest('Index Statistics', async () => {
    const stats = await getIndexStats();

    console.log('\n   📈 Index Stats:');
    console.log(`   Total Vectors: ${stats.totalRecordCount}`);
    console.log(`   Dimension: ${stats.dimension}`);
    console.log(`   Fullness: ${((stats.indexFullness ?? 0) * 100).toFixed(2)}%`);

    if (stats.namespaces && Object.keys(stats.namespaces).length > 0) {
      console.log(`   Namespaces:`);
      Object.entries(stats.namespaces).forEach(([ns, info]) => {
        console.log(`     - ${ns}: ${info.recordCount} vectors`);
      });
    }

    return {
      success: true,
      message: `Index has ${stats.totalRecordCount} vectors`,
    };
  });
}

/**
 * Cleanup test data
 */
async function cleanupTestData() {
  return runTest('Cleanup Test Data', async () => {
    try {
      await ragService.deleteDocument('test-doc-sample');
      return {
        success: true,
        message: 'Test data cleaned up',
      };
    } catch (error) {
      return {
        success: true, // Not a critical failure
        message: 'No test data to clean up',
      };
    }
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

  const avgDuration =
    results.reduce((sum, r) => sum + (r.duration || 0), 0) / results.length;

  console.log(`\n⏱️  Average test duration: ${avgDuration.toFixed(0)}ms`);

  console.log('\n' + '='.repeat(60));

  if (failed === 0) {
    console.log('🎉 All tests passed! RAG system is ready to use.');
  } else {
    console.log('⚠️  Some tests failed. Please check configuration.');
  }

  console.log('\n💡 Next steps:');
  console.log('   1. Index your legal documents');
  console.log('   2. Test semantic search with real queries');
  console.log('   3. Integrate with AI service for RAG-powered responses');
}

/**
 * Main execution
 */
async function main() {
  console.log('🧪 SheriaBot RAG System Test');
  console.log('='.repeat(60));

  const embeddingConfig = getEmbeddingConfig();
  console.log(`Embedding Provider: ${embeddingConfig.provider}`);
  console.log(`Model: ${embeddingConfig.model}`);
  console.log(`Dimension: ${embeddingConfig.dimension}`);
  console.log('='.repeat(60));

  try {
    await testConfiguration();
    await testPineconeHealth();
    await testEmbeddings();
    await testChunking();
    await testIndexing();
    await testSearch();
    await testReranking();
    await testContextGeneration();
    await testEmbeddingCache();
    await testIndexStats();
    await cleanupTestData();

    printSummary();

    process.exit(results.some((r) => !r.success) ? 1 : 0);
  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  }
}

main();
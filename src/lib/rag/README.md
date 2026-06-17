# RAG System (Retrieval-Augmented Generation)

This directory contains the RAG system for SheriaBot using Pinecone vector database for semantic search over Kenyan legal documents.

## 📁 Structure

```
rag/
├── client.ts         # Pinecone client and vector operations
├── embeddings.ts     # Embedding generation (HuggingFace/OpenAI)
├── chunking.ts       # Document chunking for legal texts
├── rag.service.ts    # High-level RAG service
└── README.md         # This file
```

## 🚀 Getting Started

### 1. Set Up Pinecone

Create a free account at [pinecone.io](https://www.pinecone.io) and create an index:

```bash
# Index settings:
# - Name: sheriabot-legal-docs
# - Dimension: 384 (for HuggingFace) or 1536 (for OpenAI)
# - Metric: cosine
# - Cloud: AWS
# - Region: us-east-1
```

### 2. Environment Setup

Add to `.env`:

```bash
# Pinecone
PINECONE_API_KEY=your-pinecone-api-key
PINECONE_INDEX_NAME=sheriabot-legal-docs

# Embeddings (choose one)
EMBEDDING_PROVIDER=huggingface  # or 'openai'

# HuggingFace (free)
HUGGINGFACE_API_KEY=your-huggingface-token

# OR OpenAI (paid, higher quality)
OPENAI_API_KEY=sk-...
```

### 3. Install Dependencies

```bash
npm install @pinecone-database/pinecone
```



## 📚 Usage Examples

### Index a Document

```typescript
import { ragService } from '@/lib/rag/rag.service';

const chunksIndexed = await ragService.indexDocument({
  id: 'data-protection-act-2019',
  title: 'Data Protection Act 2019',
  content: '... full text of the act ...',
  documentType: 'LEGAL_ACT',
  actName: 'Data Protection Act',
  year: 2019,
  regulatoryArea: 'Data Protection',
});

console.log(`Indexed ${chunksIndexed} chunks`);
```

### Index Kenyan Legal Act (Helper)

```typescript
import { indexKenyanLegalAct } from '@/lib/rag/rag.service';

const chunks = await indexKenyanLegalAct(
  'Data Protection Act',
  2019,
  actContent,
  'Data Protection'
);
```

### Search Documents

```typescript
const results = await ragService.search(
  'What are the KYC requirements for digital lending?',
  {
    topK: 10,           // Return top 10 results
    minScore: 0.7,      // Minimum relevance score
    filter: {           // Optional metadata filter
      regulatoryArea: 'Digital Lending'
    }
  }
);

results.forEach(result => {
  console.log(`${result.rank}. ${result.documentTitle}`);
  console.log(`   Section: ${result.section}`);
  console.log(`   Score: ${result.score}`);
  console.log(`   Text: ${result.chunkText.substring(0, 100)}...`);
});
```

### Search with Reranking

```typescript
// Better relevance through multi-factor reranking
const results = await ragService.searchWithReranking(
  'data protection requirements for fintech',
  { topK: 5, minScore: 0.6 }
);
```

### Get Context for AI

```typescript
import { searchAndGetContext } from '@/lib/rag/rag.service';

const { context, results, citations } = await searchAndGetContext(
  'What are the licensing requirements for digital lenders?',
  { topK: 5 }
);

// Use context in AI prompt
const aiResponse = await aiService.answerComplianceQuery({
  question: 'What are the licensing requirements?',
  context,  // Relevant legal text from RAG
});

console.log('Citations:', citations);
```

### Manual Context Generation

```typescript
const results = await ragService.search(query);

// Generate context for AI prompt (max 5 chunks, 4000 chars)
const context = ragService.getContextForPrompt(results, 5, 4000);

// Extract citations
const citations = ragService.extractCitations(results);

// Get search summary
const summary = ragService.generateSearchSummary(query, results);
console.log(summary);
```

### Index Multiple Documents

```typescript
const documents = [
  {
    id: 'dpa-2019',
    title: 'Data Protection Act 2019',
    content: '...',
    documentType: 'LEGAL_ACT',
    actName: 'Data Protection Act',
    year: 2019,
    regulatoryArea: 'Data Protection',
  },
  {
    id: 'nps-2011',
    title: 'National Payment Systems Act 2011',
    content: '...',
    documentType: 'LEGAL_ACT',
    actName: 'National Payment Systems Act',
    year: 2011,
    regulatoryArea: 'Payment Systems',
  },
];

await ragService.indexDocuments(documents);
```

### Delete Document

```typescript
await ragService.deleteDocument('data-protection-act-2019');
```

## 🔧 Document Chunking

### Basic Chunking

```typescript
import { chunkDocument } from '@/lib/rag/chunking';

const chunks = chunkDocument(documentText, {
  maxChunkSize: 1000,      // Max characters per chunk
  chunkOverlap: 200,       // Overlap between chunks
  respectSentences: true,  // Break at sentence boundaries
  respectSections: true,   // Keep sections together
});

chunks.forEach(chunk => {
  console.log(`Chunk ${chunk.index}:`);
  console.log(`  Section: ${chunk.section}`);
  console.log(`  Length: ${chunk.text.length}`);
  console.log(`  Citations: ${chunk.citation || 'None'}`);
});
```

### Chunk Legal Act

```typescript
import { chunkLegalAct } from '@/lib/rag/chunking';

const chunks = chunkLegalAct(
  actText,
  'Data Protection Act',
  2019,
  'Data Protection'
);
```

### Preview Chunks

```typescript
import { previewChunks } from '@/lib/rag/chunking';

previewChunks(chunks, 3); // Preview first 3 chunks
```

## 🎯 Embeddings

### Generate Embedding

```typescript
import { generateEmbedding } from '@/lib/rag/embeddings';

const embedding = await generateEmbedding(
  'The Data Protection Act governs personal data in Kenya'
);

console.log(`Embedding dimension: ${embedding.length}`);
```

### Batch Embeddings

```typescript
import { generateBatchEmbeddings } from '@/lib/rag/embeddings';

const texts = [
  'First document text',
  'Second document text',
  'Third document text',
];

const embeddings = await generateBatchEmbeddings(texts);
console.log(`Generated ${embeddings.length} embeddings`);
```

### Embedding Providers

**HuggingFace (Default - Free):**
- Model: `sentence-transformers/all-MiniLM-L6-v2`
- Dimension: 384
- Speed: Fast
- Cost: Free
- Quality: Good for most use cases

**OpenAI (Optional - Paid):**
- Model: `text-embedding-3-small`
- Dimension: 1536
- Speed: Very fast
- Cost: ~$0.00002 per 1K tokens
- Quality: Excellent

Switch providers in `.env`:
```bash
EMBEDDING_PROVIDER=openai  # or 'huggingface'
```

### Embedding Cache

Embeddings are automatically cached in Redis for 30 days.

```typescript
import { getEmbeddingStats, clearEmbeddingCache } from '@/lib/rag/embeddings';

const stats = await getEmbeddingStats();
console.log(`Cached: ${stats.cacheSize} embeddings`);

// Clear cache
const cleared = await clearEmbeddingCache();
console.log(`Cleared ${cleared} embeddings`);
```

## 🗄️ Pinecone Operations

### Low-Level Client

```typescript
import { upsertVectors, queryVectors, deleteVectors } from '@/lib/rag/client';

// Upsert vectors
await upsertVectors([
  {
    id: 'doc1:chunk0',
    values: [0.1, 0.2, ...], // 384 or 1536 dimensions
    metadata: {
      documentId: 'doc1',
      documentTitle: 'Sample Doc',
      chunkText: '...',
      // ... other metadata
    },
  },
]);

// Query vectors
const results = await queryVectors(
  queryEmbedding,
  10,  // topK
  undefined,  // namespace
  { regulatoryArea: 'Data Protection' }  // filter
);

// Delete vectors
await deleteVectors(['doc1:chunk0', 'doc1:chunk1']);
```

### Index Statistics

```typescript
import { getIndexStats } from '@/lib/rag/client';

const stats = await getIndexStats();
console.log({
  totalVectors: stats.totalVectorCount,
  dimension: stats.dimension,
  fullness: stats.indexFullness,
  namespaces: stats.namespaces,
});
```

### Health Check

```typescript
import { checkPineconeHealth } from '@/lib/rag/client';

const healthy = await checkPineconeHealth();
console.log('Pinecone healthy:', healthy);
```

## 🎨 Advanced Features

### Metadata Filtering

Filter search results by metadata:

```typescript
const results = await ragService.search(query, {
  filter: {
    regulatoryArea: 'Digital Lending',
    year: { $gte: 2020 },
    documentType: 'LEGAL_ACT',
  },
});
```

### Namespaces

Organize vectors by namespace:

```typescript
// Index to namespace
await upsertVectors(vectors, 'kenya-acts');

// Search in namespace
const results = await ragService.search(query, {
  namespace: 'kenya-acts',
});
```

### Reranking Algorithm

The reranking system boosts results based on:
1. **Vector similarity** (primary score)
2. **Term matching** (+0.1 for query terms in chunk)
3. **Citations present** (+0.05 if chunk has citations)
4. **Section relevance** (+0.05 if section name matches query)

### Custom Chunk Configuration

```typescript
const chunks = chunkDocument(text, {
  maxChunkSize: 800,       // Smaller for legal precision
  chunkOverlap: 150,       // More overlap for context
  respectSentences: true,  // Always for legal texts
  respectSections: true,   // Keep legal sections intact
});
```

## 📊 Monitoring

### Check System Health

```typescript
import { checkPineconeHealth } from '@/lib/rag/client';
import { getEmbeddingStats } from '@/lib/rag/embeddings';
import { getIndexStats } from '@/lib/rag/client';

const pineconeHealthy = await checkPineconeHealth();
const embeddingStats = await getEmbeddingStats();
const indexStats = await getIndexStats();

console.log({
  pineconeHealthy,
  embeddingProvider: embeddingStats.provider,
  cachedEmbeddings: embeddingStats.cacheSize,
  totalVectors: indexStats.totalVectorCount,
  indexDimension: indexStats.dimension,
});
```

## 🐛 Troubleshooting

### Issue: No Search Results

**Possible causes:**
1. Index is empty - check with `getIndexStats()`
2. Query embedding dimension mismatch - verify provider
3. minScore too high - try lowering to 0.5
4. Wrong namespace - check namespace parameter

**Solutions:**
```typescript
// Check if index has vectors
const stats = await getIndexStats();
console.log('Total vectors:', stats.totalVectorCount);

// Try lower min score
const results = await ragService.search(query, { minScore: 0.5 });

// Check embedding dimension
const config = getEmbeddingConfig();
console.log('Embedding dimension:', config.dimension);
```

### Issue: Slow Indexing

**Solutions:**
- Use batch indexing for multiple documents
- Reduce chunk size to create fewer chunks
- Check Redis cache is working (avoids re-embedding)

### Issue: Poor Search Quality

**Solutions:**
- Use reranking: `searchWithReranking()`
- Increase topK to get more candidates
- Adjust chunk size (smaller = more precise, larger = more context)
- Try OpenAI embeddings for better quality

## 🚀 Best Practices

1. **Chunk Size**: 800-1200 chars for legal texts
2. **Overlap**: 150-200 chars for context continuity
3. **Respect Sections**: Always true for legal documents
4. **Min Score**: 0.7 for high precision, 0.5 for higher recall
5. **Reranking**: Use for important queries
6. **Caching**: Embeddings cached for 30 days automatically
7. **Metadata**: Add rich metadata for better filtering
8. **Citations**: Automatically extracted from chunks
9. **Context Length**: Keep AI context under 4000 chars
10. **Testing**: Always preview chunks before indexing

## 📈 Performance

**Indexing:**
- ~100-200 chunks/minute with HuggingFace
- ~500-1000 chunks/minute with OpenAI
- Parallel processing for batch operations

**Search:**
- <100ms for most queries
- <200ms with reranking
- Cached embeddings = instant

**Storage:**
- ~4KB per vector (384d with metadata)
- ~16KB per vector (1536d with metadata)
- Free tier: 100,000 vectors

## 💡 Integration with AI Service

```typescript
import { searchAndGetContext } from '@/lib/rag/rag.service';
import { aiService } from '@/lib/ai/ai.service';

// Search for relevant legal context
const { context, citations } = await searchAndGetContext(
  'What are KYC requirements?'
);

// Answer with RAG context
const response = await aiService.answerComplianceQuery({
  question: 'What are KYC requirements?',
  context,  // RAG provides relevant legal text
});

// Citations are automatically extracted
console.log('Legal citations:', citations);
```

## 📚 Additional Resources

- [Pinecone Documentation](https://docs.pinecone.io)
- [HuggingFace Inference API](https://huggingface.co/docs/api-inference)
- [OpenAI Embeddings](https://platform.openai.com/docs/guides/embeddings)
- [RAG Best Practices](https://www.pinecone.io/learn/retrieval-augmented-generation/)
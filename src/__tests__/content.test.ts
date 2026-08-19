import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContentService } from '../lib/content/content.service';
import {
  createContentSchema,
  updateContentSchema,
  listContentSchema,
  listPublishedKnowledgeBaseSchema,
  getContentBySlugSchema,
  rateContentSchema,
} from '../server/schemas/content.schema';

// ============================================
// Content Service Unit Tests
// ============================================

describe('ContentService', () => {
  let service: ContentService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      legalDocument: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        $transaction: vi.fn(),
      },
      $transaction: vi.fn(),
    };
    service = new ContentService(mockPrisma);
  });

  describe('generateSlug', () => {
    it('should generate a slug from a title', async () => {
      mockPrisma.legalDocument.findUnique.mockResolvedValue(null);

      const slug = await service.generateSlug('Hello World Article');
      expect(slug).toBe('hello-world-article');
    });

    it('should handle special characters', async () => {
      mockPrisma.legalDocument.findUnique.mockResolvedValue(null);

      const slug = await service.generateSlug('KYC & AML: Compliance Guide (2024)');
      expect(slug).toBe('kyc-aml-compliance-guide-2024');
    });

    it('should append a number if slug exists', async () => {
      mockPrisma.legalDocument.findUnique
        .mockResolvedValueOnce({ id: 'existing-id' }) // first check: slug exists
        .mockResolvedValueOnce(null); // second check: slug-1 is available

      const slug = await service.generateSlug('Hello World');
      expect(slug).toBe('hello-world-1');
    });

    it('should handle multiple collisions', async () => {
      mockPrisma.legalDocument.findUnique
        .mockResolvedValueOnce({ id: 'id1' }) // hello-world exists
        .mockResolvedValueOnce({ id: 'id2' }) // hello-world-1 exists
        .mockResolvedValueOnce({ id: 'id3' }) // hello-world-2 exists
        .mockResolvedValueOnce(null); // hello-world-3 is available

      const slug = await service.generateSlug('Hello World');
      expect(slug).toBe('hello-world-3');
    });
  });

  describe('slugExists', () => {
    it('should return true when slug exists', async () => {
      mockPrisma.legalDocument.findUnique.mockResolvedValue({ id: 'some-id' });

      const exists = await service.slugExists('my-slug');
      expect(exists).toBe(true);
    });

    it('should return false when slug does not exist', async () => {
      mockPrisma.legalDocument.findUnique.mockResolvedValue(null);

      const exists = await service.slugExists('my-slug');
      expect(exists).toBe(false);
    });

    it('should exclude a specific document ID', async () => {
      mockPrisma.legalDocument.findUnique.mockResolvedValue({ id: 'doc-123' });

      const exists = await service.slugExists('my-slug', 'doc-123');
      expect(exists).toBe(false);
    });
  });

  describe('sanitizeHtml', () => {
    it('should strip script tags', () => {
      const html = '<p>Hello</p><script>alert("xss")</script>';
      const result = service.sanitizeHtml(html);
      expect(result).not.toContain('<script');
      expect(result).toContain('<p>Hello</p>');
    });

    it('should strip event handlers', () => {
      const html = '<div onclick="alert(1)">Click</div>';
      const result = service.sanitizeHtml(html);
      expect(result).not.toContain('onclick');
    });

    it('should strip javascript: URLs', () => {
      const html = '<a href="javascript:alert(1)">Link</a>';
      const result = service.sanitizeHtml(html);
      expect(result).not.toContain('javascript:');
    });

    it('should strip iframe tags', () => {
      const html = '<iframe src="http://evil.com"></iframe><p>Safe</p>';
      const result = service.sanitizeHtml(html);
      expect(result).not.toContain('<iframe');
      expect(result).toContain('<p>Safe</p>');
    });
  });

  describe('renderMarkdown', () => {
    it('should convert headings', () => {
      const md = '# Title\n## Subtitle\n### Section';
      const html = service.renderMarkdown(md);
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<h2>Subtitle</h2>');
      expect(html).toContain('<h3>Section</h3>');
    });

    it('should convert bold and italic', () => {
      const md = '**bold** and *italic*';
      const html = service.renderMarkdown(md);
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('should convert inline code', () => {
      const md = 'Use `npm install` to install';
      const html = service.renderMarkdown(md);
      expect(html).toContain('<code>npm install</code>');
    });

    it('should convert links', () => {
      const md = '[SheriaBot](https://sheriabot.com)';
      const html = service.renderMarkdown(md);
      expect(html).toContain('<a href="https://sheriabot.com">SheriaBot</a>');
    });

    it('should sanitize the output', () => {
      const md = '# Title\n<script>alert(1)</script>';
      const html = service.renderMarkdown(md);
      expect(html).not.toContain('<script');
    });
  });

  describe('generateExcerpt', () => {
    it('should return short content as-is', () => {
      const content = 'A short paragraph.';
      const excerpt = service.generateExcerpt(content);
      expect(excerpt).toBe('A short paragraph.');
    });

    it('should truncate long content', () => {
      const content = 'A '.repeat(200);
      const excerpt = service.generateExcerpt(content, 50);
      expect(excerpt.length).toBeLessThanOrEqual(55); // 50 + "..."
      expect(excerpt).toMatch(/\.\.\.$/);
    });

    it('should strip HTML tags', () => {
      const content = '<p>Hello <strong>world</strong></p>';
      const excerpt = service.generateExcerpt(content);
      expect(excerpt).toBe('Hello world');
    });

    it('should strip markdown syntax', () => {
      const content = '# Hello **world** with [links](http://example.com)';
      const excerpt = service.generateExcerpt(content);
      expect(excerpt).not.toContain('#');
      expect(excerpt).not.toContain('**');
    });
  });

  describe('incrementViewCount', () => {
    it('should increment view count', async () => {
      mockPrisma.legalDocument.update.mockResolvedValue({});

      await service.incrementViewCount('doc-123');

      expect(mockPrisma.legalDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc-123' },
        data: { viewCount: { increment: 1 } },
      });
    });

    it('should not throw on error', async () => {
      mockPrisma.legalDocument.update.mockRejectedValue(new Error('DB error'));

      await expect(service.incrementViewCount('doc-123')).resolves.not.toThrow();
    });
  });

  describe('rateContent', () => {
    it('should increment helpfulCount when helpful is true', async () => {
      mockPrisma.legalDocument.update.mockResolvedValue({});

      await service.rateContent('doc-123', true);

      expect(mockPrisma.legalDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc-123' },
        data: { helpfulCount: { increment: 1 } },
      });
    });

    it('should increment notHelpfulCount when helpful is false', async () => {
      mockPrisma.legalDocument.update.mockResolvedValue({});

      await service.rateContent('doc-123', false);

      expect(mockPrisma.legalDocument.update).toHaveBeenCalledWith({
        where: { id: 'doc-123' },
        data: { notHelpfulCount: { increment: 1 } },
      });
    });
  });
});

// ============================================
// Content Schema Validation Tests
// ============================================

describe('Content Schemas', () => {
  describe('createContentSchema', () => {
    it('should reject BLOG_POST content type', () => {
      const input = {
        contentType: 'BLOG_POST',
        title: 'Understanding KYC Requirements',
        content: 'KYC stands for Know Your Customer...',
        tags: ['KYC', 'compliance'],
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should validate a KB article', () => {
      const input = {
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        title: 'How to Submit Compliance Reports',
        content: 'Step 1: Navigate to the reports section...',
        category: 'Compliance',
        slug: 'how-to-submit-compliance-reports',
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject REGULATORY_DOCUMENT content type', () => {
      const input = {
        contentType: 'REGULATORY_DOCUMENT',
        title: 'Test',
        content: 'Content...',
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject empty title', () => {
      const input = {
        contentType: 'BLOG_POST',
        title: '',
        content: 'Some content',
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should reject invalid slug format', () => {
      const input = {
        contentType: 'BLOG_POST',
        title: 'Test',
        content: 'Content',
        slug: 'INVALID SLUG!!',
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(false);
    });

    it('should accept valid slug format', () => {
      const input = {
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        title: 'Test',
        content: 'Content',
        slug: 'valid-slug-123',
      };

      const result = createContentSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should default status to DRAFT', () => {
      const input = {
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        title: 'Test Article',
        content: 'Some content here',
      };

      const result = createContentSchema.parse(input);
      expect(result.status).toBe('DRAFT');
    });

    it('should default tags to empty array', () => {
      const input = {
        contentType: 'KNOWLEDGE_BASE_ARTICLE',
        title: 'Test Article',
        content: 'Some content here',
      };

      const result = createContentSchema.parse(input);
      expect(result.tags).toEqual([]);
    });
  });

  describe('updateContentSchema', () => {
    it('should allow partial updates', () => {
      const input = {
        id: 'doc-123',
        title: 'Updated Title',
      };

      const result = updateContentSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should require an id', () => {
      const input = {
        title: 'Updated Title',
      };

      const result = updateContentSchema.safeParse(input);
      expect(result.success).toBe(false);
    });
  });

  describe('listContentSchema', () => {
    it('should apply defaults', () => {
      const input = {};
      const result = listContentSchema.parse(input);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('should accept all filter options', () => {
      const input = {
        page: 2,
        limit: 10,
        contentType: 'BLOG_POST',
        status: 'PUBLISHED',
        category: 'Compliance',
        tag: 'KYC',
        search: 'requirements',
      };

      const result = listContentSchema.safeParse(input);
      expect(result.success).toBe(true);
    });
  });

  describe('listPublishedKnowledgeBaseSchema', () => {
    it('should apply public listing defaults', () => {
      const result = listPublishedKnowledgeBaseSchema.parse({});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(12);
    });

    it('should trim empty filters to undefined', () => {
      const result = listPublishedKnowledgeBaseSchema.parse({
        search: '  ',
        category: '  ',
        tag: '  ',
      });

      expect(result.search).toBeUndefined();
      expect(result.category).toBeUndefined();
      expect(result.tag).toBeUndefined();
    });

    it('should enforce bounded pagination limits', () => {
      const result = listPublishedKnowledgeBaseSchema.safeParse({ limit: 51 });
      expect(result.success).toBe(false);
    });

    it('should accept bounded search and filters', () => {
      const result = listPublishedKnowledgeBaseSchema.safeParse({
        page: 2,
        limit: 24,
        search: 'data protection',
        category: 'AML',
        tag: 'CBK',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('getContentBySlugSchema', () => {
    it('should require a slug', () => {
      const result = getContentBySlugSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept a valid slug', () => {
      const result = getContentBySlugSchema.safeParse({ slug: 'my-article' });
      expect(result.success).toBe(true);
    });
  });

  describe('rateContentSchema', () => {
    it('should require id and helpful boolean', () => {
      const result = rateContentSchema.safeParse({ id: 'doc-123', helpful: true });
      expect(result.success).toBe(true);
    });

    it('should reject non-boolean helpful', () => {
      const result = rateContentSchema.safeParse({ id: 'doc-123', helpful: 'yes' });
      expect(result.success).toBe(false);
    });
  });
});

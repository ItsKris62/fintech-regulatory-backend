import type { PrismaClient } from '@/generated/prisma';
import { logger } from '@/utils/logger';

/**
 * Content Service
 *
 * Handles content-specific operations like slug generation,
 * HTML sanitization, and markdown rendering for blogs and KB articles.
 */
export class ContentService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Generate a URL-safe slug from a title.
   * Appends a numeric suffix if the slug already exists.
   */
  async generateSlug(title: string): Promise<string> {
    const base = title
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');

    let slug = base;
    let counter = 1;

    while (await this.slugExists(slug)) {
      slug = `${base}-${counter}`;
      counter++;
    }

    return slug;
  }

  /**
   * Check if a slug already exists in the database.
   */
  async slugExists(slug: string, excludeId?: string): Promise<boolean> {
    const existing = await this.prisma.legalDocument.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (!existing) return false;
    if (excludeId && existing.id === excludeId) return false;
    return true;
  }

  /**
   * Sanitize HTML content to prevent XSS.
   * Strips dangerous tags/attributes while preserving safe formatting.
   */
  sanitizeHtml(html: string): string {
    // Strip script tags and event handlers
    let sanitized = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
      .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
      .replace(/javascript:/gi, '');

    // Strip iframe, object, embed tags
    sanitized = sanitized
      .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, '')
      .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, '')
      .replace(/<embed[^>]*>/gi, '');

    return sanitized;
  }

  /**
   * Convert basic markdown to HTML.
   * For full markdown support, consider adding a library like marked.
   */
  renderMarkdown(markdown: string): string {
    let html = markdown;

    // Headers
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Bold and italic
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Code blocks
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // Unordered lists
    html = html.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
    html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

    // Paragraphs (lines not already wrapped)
    html = html.replace(/^(?!<[huplo])((?!\s*$).+)$/gm, '<p>$1</p>');

    // Line breaks
    html = html.replace(/\n{2,}/g, '\n');

    return this.sanitizeHtml(html);
  }

  /**
   * Generate an excerpt from content if not provided.
   */
  generateExcerpt(content: string, maxLength: number = 200): string {
    // Strip HTML tags and markdown syntax
    const plain = content
      .replace(/<[^>]+>/g, '')
      .replace(/[#*`\[\]()]/g, '')
      .replace(/\n+/g, ' ')
      .trim();

    if (plain.length <= maxLength) return plain;
    return plain.substring(0, maxLength).replace(/\s+\S*$/, '') + '...';
  }

  /**
   * Increment the view count for a content item.
   */
  async incrementViewCount(id: string): Promise<void> {
    try {
      await this.prisma.legalDocument.update({
        where: { id },
        data: { viewCount: { increment: 1 } },
      });
    } catch (error: any) {
      logger.warn({
        type: 'content_view_count_error',
        documentId: id,
        error: error.message,
      });
    }
  }

  /**
   * Record a helpful/not helpful rating.
   */
  async rateContent(id: string, helpful: boolean): Promise<void> {
    await this.prisma.legalDocument.update({
      where: { id },
      data: helpful
        ? { helpfulCount: { increment: 1 } }
        : { notHelpfulCount: { increment: 1 } },
    });
  }

  /**
   * Create a new version of existing content.
   * Marks the old version as non-latest and creates a new record.
   */
  async createVersion(
    parentId: string,
    updates: {
      title?: string;
      content?: string;
      excerpt?: string;
      htmlContent?: string;
    },
    authorId: string,
  ): Promise<string> {
    const parent = await this.prisma.legalDocument.findUnique({
      where: { id: parentId },
    });

    if (!parent) {
      throw new Error(`Document ${parentId} not found`);
    }

    const [newDoc] = await this.prisma.$transaction([
      this.prisma.legalDocument.create({
        data: {
          actName: parent.actName,
          documentType: parent.documentType,
          originalFilename: parent.originalFilename,
          fileUrl: parent.fileUrl,
          fileSize: parent.fileSize,
          mimeType: parent.mimeType,
          contentType: parent.contentType,
          contentStatus: 'DRAFT',
          title: updates.title ?? parent.title,
          slug: parent.slug,
          excerpt: updates.excerpt ?? parent.excerpt,
          content: updates.content ?? parent.content,
          htmlContent: updates.htmlContent ?? parent.htmlContent,
          tags: parent.tags,
          category: parent.category,
          subcategory: parent.subcategory,
          seoTitle: parent.seoTitle,
          seoDescription: parent.seoDescription,
          seoKeywords: parent.seoKeywords,
          authorId,
          version: parent.version + 1,
          parentId,
          isLatestVersion: true,
          organizationId: parent.organizationId,
          userId: parent.userId,
          keywords: parent.keywords,
          amendedBy: parent.amendedBy,
          regulatoryBody: parent.regulatoryBody,
        },
      }),
      this.prisma.legalDocument.update({
        where: { id: parentId },
        data: {
          isLatestVersion: false,
          // Clear slug from old version so new version can claim it
          slug: null,
        },
      }),
    ]);

    logger.info({
      type: 'content_version_created',
      parentId,
      newDocumentId: newDoc.id,
      version: parent.version + 1,
    });

    return newDoc.id;
  }
}

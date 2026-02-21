/**
 * Policy Exporter
 * Handles export of policies to PDF, DOCX, JSON, and Markdown formats
 */

import { storageService } from '@/lib/storage/storage.service';
import { logger } from '@/utils/logger';
import {
  type PolicyWithDetails,
  type ExportFormat,
  type ExportResult,
  type ExportOptions,
  POLICY_CONSTANTS,
  PolicyError,
} from './policy.types';
import {
  generateExportFilename,
  getRegulatoryAreaName,
  extractSections,
} from './policy.utils';

/**
 * Policy Exporter Class
 * Handles conversion of policies to various export formats
 */
export class PolicyExporter {
  /**
   * Export policy to specified format
   */
  async export(
    policy: PolicyWithDetails,
    format: ExportFormat,
    options: ExportOptions = {}
  ): Promise<ExportResult> {
    logger.info({
      type: 'policy_export_started',
      policyId: policy.id,
      format,
    });

    try {
      let buffer: Buffer;
      let filename: string;

      switch (format) {
        case 'PDF':
          buffer = await this.exportToPDF(policy, options);
          filename = generateExportFilename(policy.title, 'PDF');
          break;
        case 'DOCX':
          buffer = await this.exportToDOCX(policy, options);
          filename = generateExportFilename(policy.title, 'DOCX');
          break;
        case 'JSON':
          buffer = await this.exportToJSON(policy, options);
          filename = generateExportFilename(policy.title, 'JSON');
          break;
        case 'MARKDOWN':
          buffer = await this.exportToMarkdown(policy, options);
          filename = generateExportFilename(policy.title, 'MARKDOWN');
          break;
        default:
          throw new PolicyError(`Unsupported export format: ${format}`, 'INVALID_FORMAT', 400);
      }

      // Upload to storage
      const uploadResult = await storageService.uploadTempFile(
        buffer,
        filename,
        POLICY_CONSTANTS.EXPORT_EXPIRY_HOURS * 60 * 60
      );

      // Generate signed URL
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + POLICY_CONSTANTS.EXPORT_EXPIRY_HOURS);

      const downloadUrl = await storageService.getDownloadUrl(
        uploadResult.key,
        POLICY_CONSTANTS.EXPORT_EXPIRY_HOURS * 60 * 60
      );

      logger.info({
        type: 'policy_export_success',
        policyId: policy.id,
        format,
        fileSize: buffer.length,
      });

      return {
        success: true,
        format,
        downloadUrl,
        expiresAt,
        fileSize: buffer.length,
        filename,
      };
    } catch (error: any) {
      logger.error({
        type: 'policy_export_error',
        policyId: policy.id,
        format,
        error: error.message,
      });

      throw new PolicyError(
        `Failed to export policy: ${error.message}`,
        'EXPORT_FAILED',
        500
      );
    }
  }

  /**
   * Export to PDF format
   * Uses HTML -> PDF conversion
   */
  async exportToPDF(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): Promise<Buffer> {
    // Generate HTML first (for future PDF rendering)
    this.generateHTML(policy, options);
    
    // Convert HTML to PDF using puppeteer or similar
    // For now, we'll create a simple text-based PDF structure
    // In production, you'd use a library like puppeteer or pdfkit
    
    const pdfContent = this.generatePDFContent(policy, options);
    return Buffer.from(pdfContent, 'utf-8');
  }

  /**
   * Export to DOCX format
   * Uses docx library for proper Word document structure
   */
  async exportToDOCX(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): Promise<Buffer> {
    // In production, use the 'docx' npm package
    // For now, create a simple XML structure that Word can open
    
    const docxContent = this.generateDOCXContent(policy, options);
    return Buffer.from(docxContent, 'utf-8');
  }

  /**
   * Export to JSON format
   */
  async exportToJSON(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): Promise<Buffer> {
    const exportData: any = {
      id: policy.id,
      title: policy.title,
      description: policy.description,
      content: policy.content,
      summary: policy.summary,
      status: policy.status,
      organizationType: policy.organizationType,
      regulatoryAreas: policy.regulatoryAreas.map(area => ({
        code: area,
        name: getRegulatoryAreaName(area),
      })),
      version: policy.version,
      createdAt: policy.createdAt,
      updatedAt: policy.updatedAt,
      publishedAt: policy.publishedAt,
    };

    if (options.includeMetadata) {
      exportData.metadata = {
        aiModel: policy.aiModel,
        tokensUsed: policy.tokensUsed,
        generationTime: policy.generationTime,
        exportedAt: new Date().toISOString(),
      };
    }

    if (options.includeCitations) {
      exportData.citations = policy.citations.map(c => ({
        source: c.source,
        title: c.title,
        section: c.section,
        content: c.content,
        verified: c.verified,
      }));
    }

    if (options.includeVersionHistory) {
      exportData.versions = policy.versions.map(v => ({
        version: v.version,
        title: v.title,
        changeDescription: v.changeDescription,
        createdAt: v.createdAt,
      }));
    }

    return Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
  }

  /**
   * Export to Markdown format
   */
  async exportToMarkdown(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): Promise<Buffer> {
    let markdown = '';

    // Title
    markdown += `# ${policy.title}\n\n`;

    // Metadata
    if (options.includeMetadata) {
      markdown += `---\n`;
      markdown += `Organization Type: ${policy.organizationType}\n`;
      markdown += `Status: ${policy.status}\n`;
      markdown += `Version: ${policy.version}\n`;
      markdown += `Created: ${policy.createdAt.toISOString()}\n`;
      markdown += `Updated: ${policy.updatedAt.toISOString()}\n`;
      if (policy.publishedAt) {
        markdown += `Published: ${policy.publishedAt.toISOString()}\n`;
      }
      markdown += `Regulatory Areas: ${policy.regulatoryAreas.map(getRegulatoryAreaName).join(', ')}\n`;
      markdown += `---\n\n`;
    }

    // Summary
    if (policy.summary) {
      markdown += `## Executive Summary\n\n`;
      markdown += `${policy.summary}\n\n`;
    }

    // Main content
    markdown += policy.content;
    markdown += '\n\n';

    // Citations
    if (options.includeCitations && policy.citations.length > 0) {
      markdown += `## References\n\n`;
      policy.citations.forEach((citation, index) => {
        markdown += `${index + 1}. **${citation.source}**`;
        if (citation.section) {
          markdown += `, Section ${citation.section}`;
        }
        if (citation.content) {
          markdown += `\n   > ${citation.content}`;
        }
        if (citation.verified) {
          markdown += ` ✓`;
        }
        markdown += '\n\n';
      });
    }

    // Footer
    if (options.footerText) {
      markdown += `---\n\n*${options.footerText}*\n`;
    }

    return Buffer.from(markdown, 'utf-8');
  }

  /**
   * Generate shareable link for export
   */
  async generateShareLink(
    policy: PolicyWithDetails,
    format: ExportFormat,
    _expiresInHours: number = 24
  ): Promise<string> {
    const exportResult = await this.export(policy, format, {
      includeMetadata: true,
      includeCitations: true,
    });

    return exportResult.downloadUrl;
  }

  // ==========================================================================
  // PRIVATE METHODS - Content Generation
  // ==========================================================================

  /**
   * Generate HTML for PDF conversion
   */
  private generateHTML(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): string {
    extractSections(policy.content);
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${policy.title}</title>
  <style>
    body {
      font-family: 'Times New Roman', serif;
      line-height: 1.6;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px;
      color: #333;
    }
    h1 {
      color: #1a365d;
      border-bottom: 2px solid #1a365d;
      padding-bottom: 10px;
    }
    h2 {
      color: #2c5282;
      margin-top: 30px;
    }
    h3 {
      color: #4a5568;
    }
    .metadata {
      background: #f7fafc;
      padding: 15px;
      border-radius: 5px;
      margin-bottom: 30px;
    }
    .summary {
      font-style: italic;
      background: #ebf8ff;
      padding: 15px;
      border-left: 4px solid #3182ce;
      margin: 20px 0;
    }
    .citations {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
    }
    .citation {
      margin-bottom: 10px;
    }
    .verified {
      color: #38a169;
    }
    .footer {
      margin-top: 50px;
      padding-top: 20px;
      border-top: 1px solid #e2e8f0;
      text-align: center;
      color: #718096;
      font-size: 12px;
    }
    ${options.watermark ? `
    .watermark {
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%) rotate(-45deg);
      font-size: 100px;
      color: rgba(0, 0, 0, 0.05);
      pointer-events: none;
    }
    ` : ''}
  </style>
</head>
<body>
  ${options.watermark ? `<div class="watermark">${options.watermark}</div>` : ''}
  
  <h1>${policy.title}</h1>
  
  ${options.includeMetadata ? `
  <div class="metadata">
    <strong>Organization Type:</strong> ${policy.organizationType}<br>
    <strong>Regulatory Areas:</strong> ${policy.regulatoryAreas.map(getRegulatoryAreaName).join(', ')}<br>
    <strong>Status:</strong> ${policy.status}<br>
    <strong>Version:</strong> ${policy.version}<br>
    <strong>Last Updated:</strong> ${policy.updatedAt.toLocaleDateString()}
  </div>
  ` : ''}
  
  ${policy.summary ? `
  <div class="summary">
    <strong>Executive Summary:</strong><br>
    ${policy.summary}
  </div>
  ` : ''}
  
  ${this.markdownToHTML(policy.content)}
  
  ${options.includeCitations && policy.citations.length > 0 ? `
  <div class="citations">
    <h2>References</h2>
    ${policy.citations.map((c, i) => `
      <div class="citation">
        ${i + 1}. <strong>${c.source}</strong>${c.section ? `, Section ${c.section}` : ''}
        ${c.verified ? '<span class="verified">✓ Verified</span>' : ''}
        ${c.content ? `<br><em>"${c.content}"</em>` : ''}
      </div>
    `).join('')}
  </div>
  ` : ''}
  
  <div class="footer">
    ${options.footerText || `Generated by SheriaBot | ${new Date().toLocaleDateString()}`}
  </div>
</body>
</html>
    `;
  }

  /**
   * Simple markdown to HTML conversion
   */
  private markdownToHTML(markdown: string): string {
    return markdown
      // Headers
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Lists
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
      // Numbered lists
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      // Paragraphs
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<)(.+)$/gm, '<p>$1</p>')
      // Clean up
      .replace(/<p><\/p>/g, '')
      .replace(/<p>(<h[1-3]>)/g, '$1')
      .replace(/(<\/h[1-3]>)<\/p>/g, '$1');
  }

  /**
   * Generate PDF-compatible content
   * In production, use a proper PDF library like pdfkit
   */
  private generatePDFContent(
    policy: PolicyWithDetails,
    options: ExportOptions
  ): string {
    // This is a placeholder - in production, use pdfkit or puppeteer
    // For now, return the HTML which can be converted
    return this.generateHTML(policy, options);
  }

  /**
   * Generate DOCX-compatible content
   * In production, use the 'docx' npm package
   */
  private generateDOCXContent(
    policy: PolicyWithDetails,
    _options: ExportOptions
  ): string {
    // This is a simplified Office Open XML structure
    // In production, use the 'docx' package for proper .docx generation
    
    const content = policy.content
      .replace(/^# (.+)$/gm, '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>$1</w:t></w:r></w:p>')
      .replace(/^## (.+)$/gm, '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>$1</w:t></w:r></w:p>')
      .replace(/^### (.+)$/gm, '<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t>$1</w:t></w:r></w:p>')
      .replace(/\*\*(.+?)\*\*/g, '<w:r><w:rPr><w:b/></w:rPr><w:t>$1</w:t></w:r>')
      .replace(/^(.+)$/gm, '<w:p><w:r><w:t>$1</w:t></w:r></w:p>');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${policy.title}</w:t></w:r></w:p>
    ${content}
  </w:body>
</w:document>`;
  }
}

// Export singleton
export const policyExporter = new PolicyExporter();

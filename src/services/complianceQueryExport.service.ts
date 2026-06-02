/**
 * Compliance Query DOCX Export Service
 *
 * Generates a professional Word document containing a compliance query
 * question and its AI-generated response. Mirrors the pattern established
 * in checklist-export.service.ts and gap-analysis-export.service.ts.
 *
 * Critical docx rules (same as sibling services):
 *   - WidthType.DXA everywhere (never PERCENTAGE - breaks Google Docs)
 *   - ShadingType.CLEAR (never SOLID - causes black cell backgrounds)
 *   - No \n inside TextRun - use separate Paragraphs
 *   - PageBreak must be inside a Paragraph
 *   - A4 page size (width: 11906, height: 16838 DXA); 1-inch margins
 *   - Content width: 9026 DXA (11906 - 2 * 1440)
 */

import {
    AlignmentType,
    BorderStyle,
    Document,
    Footer,
    Header,
    HeadingLevel,
    Packer,
    PageBreak,
    PageNumber,
    Paragraph,
    TextRun,
} from 'docx';
import { logger } from '@/utils/logger';

// --- Constants ----------------------------------------------------------------

// Brand colours (mirrors checklist-export.service.ts)
const C = {
    navy: '1A2B4A',
    emerald: '00875A',
    gold: 'D4A843',
    slate: '4A5568',
    offWhite: 'F7F8FA',
    white: 'FFFFFF',
} as const;

// --- Helpers ------------------------------------------------------------------

function s(v: string | null | undefined): string {
    return v ?? '';
}

type VerificationStatus = 'verified' | 'unverified' | 'not_checked';

type StoredCitation = {
    documentTitle?: string | null;
    title?: string | null;
    source?: string | null;
    section?: string | null;
    textSnippet?: string | null;
    content?: string | null;
    score?: number | null;
    relevanceScore?: number | null;
    authorityStatus?: string | null;
    isBinding?: boolean | null;
    version?: string | null;
    verificationStatus?: VerificationStatus | string | null;
};

type NormalizedCitation = {
    documentTitle: string;
    section: string;
    textSnippet: string;
    score: number;
    authorityStatus: string;
    isBinding: boolean;
    version: string;
    verificationStatus: VerificationStatus;
};

function normalizeCitation(raw: unknown): NormalizedCitation | null {
    if (!raw || typeof raw !== 'object') return null;
    const citation = raw as StoredCitation;
    const documentTitle = s(citation.documentTitle) || s(citation.title) || s(citation.source);
    if (!documentTitle) return null;

    const status = citation.verificationStatus === 'verified' ||
        citation.verificationStatus === 'unverified' ||
        citation.verificationStatus === 'not_checked'
        ? citation.verificationStatus
        : 'not_checked';

    return {
        documentTitle,
        section: s(citation.section),
        textSnippet: (s(citation.textSnippet) || s(citation.content)).slice(0, 500),
        score: typeof citation.score === 'number'
            ? citation.score
            : typeof citation.relevanceScore === 'number'
                ? citation.relevanceScore
                : 0,
        authorityStatus: s(citation.authorityStatus) || 'IN_FORCE',
        isBinding: citation.isBinding ?? true,
        version: s(citation.version),
        verificationStatus: status,
    };
}

function verificationLabel(status: VerificationStatus): string {
    if (status === 'verified') return 'Verified';
    if (status === 'unverified') return 'Unverified';
    return 'Not checked';
}

function formatDate(d: Date): string {
    return d.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

function pageBreak(): Paragraph {
    return new Paragraph({ children: [new PageBreak()] });
}

function rule(color: string = C.navy): Paragraph {
    return new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color, space: 1 } },
        spacing: { after: 160 },
    });
}

function h1(text: string): Paragraph {
    return new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
}

function h2(text: string): Paragraph {
    return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}

function body(text: string, opts: { color?: string; italic?: boolean } = {}): Paragraph {
    return new Paragraph({
        children: [
            new TextRun({
                text,
                font: 'Arial',
                size: 22,
                color: opts.color ?? C.slate,
                italics: opts.italic,
            }),
        ],
        spacing: { after: 120 },
    });
}

function bullet(text: string): Paragraph {
    return new Paragraph({
        bullet: { level: 0 },
        children: [
            new TextRun({
                text,
                font: 'Arial',
                size: 22,
                color: C.slate,
            }),
        ],
        spacing: { after: 80 },
    });
}

function boldBody(text: string): Paragraph {
    return new Paragraph({
        children: [
            new TextRun({
                text,
                font: 'Arial',
                size: 22,
                bold: true,
                color: C.navy,
            }),
        ],
        spacing: { after: 120 },
    });
}

function stripMarkdownInline(text: string): string {
    return text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[*_~`]+/g, '')
        .replace(/^\s*>\s?/, '')
        .trim();
}

function buildMarkdownParagraphs(markdown: string): Paragraph[] {
    const nodes: Paragraph[] = [];
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    let paragraphLines: string[] = [];
    let tableRows: string[] = [];

    const flushParagraph = () => {
        if (paragraphLines.length === 0) return;
        const text = stripMarkdownInline(paragraphLines.join(' '));
        if (text) nodes.push(body(text));
        paragraphLines = [];
    };

    const flushTable = () => {
        if (tableRows.length === 0) return;

        const rows = tableRows
            .map((row) => row
                .split('|')
                .map((cell) => stripMarkdownInline(cell))
                .filter(Boolean))
            .filter((cells) => {
                if (cells.length === 0) return false;
                return !cells.every((cell) => /^:?-{3,}:?$/.test(cell));
            });

        if (rows.length > 0) {
            nodes.push(h2(rows[0].join(' | ')));
            for (const row of rows.slice(1)) {
                nodes.push(body(row.join(' - ')));
            }
        }

        tableRows = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            flushParagraph();
            flushTable();
            continue;
        }

        if (line.includes('|') && /^\|?.+\|.+\|?$/.test(line)) {
            flushParagraph();
            tableRows.push(line);
            continue;
        }

        flushTable();

        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
            flushParagraph();
            nodes.push(heading[1].length === 1 ? h1(stripMarkdownInline(heading[2])) : h2(stripMarkdownInline(heading[2])));
            continue;
        }

        const listItem = /^[-*+]\s+(.+)$/.exec(line) ?? /^\d+\.\s+(.+)$/.exec(line);
        if (listItem) {
            flushParagraph();
            nodes.push(bullet(stripMarkdownInline(listItem[1])));
            continue;
        }

        paragraphLines.push(line);
    }

    flushParagraph();
    flushTable();

    return nodes.length > 0 ? nodes : [body('No response content was available.')];
}

// --- Section builders ---------------------------------------------------------

function buildHeader(orgName?: string): Header {
    const displayName = orgName ?? 'SheriaBot';
    return new Header({
        children: [
            new Paragraph({
                children: [
                    new TextRun({ text: 'SheriaBot', font: 'Arial', size: 18, bold: true, color: C.navy }),
                    new TextRun({
                        text: `  |  Compliance Query  |  ${displayName}`,
                        font: 'Arial',
                        size: 18,
                        color: C.slate,
                    }),
                ],
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.navy } },
                spacing: { after: 60 },
            }),
        ],
    });
}

function buildFooter(): Footer {
    return new Footer({
        children: [
            new Paragraph({
                children: [
                    new TextRun({
                        text: 'Confidential  -  For Internal Use Only  |  ',
                        font: 'Arial',
                        size: 16,
                        color: C.slate,
                    }),
                    new TextRun({
                        text: 'Page ',
                        font: 'Arial',
                        size: 16,
                        color: C.slate,
                    }),
                    new TextRun({
                        children: [PageNumber.CURRENT],
                        font: 'Arial',
                        size: 16,
                        color: C.slate,
                    }),
                    new TextRun({
                        text: '  |  sheriabot.com',
                        font: 'Arial',
                        size: 16,
                        color: C.slate,
                    }),
                ],
                alignment: AlignmentType.CENTER,
                border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.navy } },
                spacing: { before: 60 },
            }),
        ],
    });
}

function buildCoverSection(params: ComplianceQueryExportParams): Paragraph[] {
    const { question, createdAt, organizationName, queryId } = params;
    const dateStr = formatDate(createdAt);

    return [
        new Paragraph({
            children: [new TextRun({ text: 'SHERIABOT', font: 'Arial', size: 48, bold: true, color: C.navy })],
            alignment: AlignmentType.CENTER,
            spacing: { before: 400, after: 160 },
        }),
        new Paragraph({
            children: [new TextRun({ text: 'Compliance Query Report', font: 'Arial', size: 36, color: C.emerald })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 80 },
        }),
        new Paragraph({
            children: [new TextRun({ text: stripMarkdownInline(question), font: 'Arial', size: 28, bold: true, color: C.navy })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 },
        }),
        new Paragraph({
            children: [new TextRun({ text: 'AI-Powered Regulatory Response', font: 'Arial', size: 24, color: C.slate })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 400 },
        }),
        rule(C.gold),

        new Paragraph({ spacing: { after: 200 } }),

        // Metadata
        boldBody('Organisation'),
        body(s(organizationName)),
        new Paragraph({ spacing: { after: 80 } }),

        boldBody('Query ID'),
        body(s(queryId)),
        new Paragraph({ spacing: { after: 80 } }),

        boldBody('Asked On'),
        body(dateStr),
        new Paragraph({ spacing: { after: 200 } }),

        new Paragraph({
            children: [
                new TextRun({
                    text: 'This document was generated by SheriaBot AI based on Kenyan regulatory sources. It is for informational purposes only and should not be considered legal advice.',
                    font: 'Arial',
                    size: 18,
                    color: C.slate,
                    italics: true,
                }),
            ],
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
        }),

        pageBreak(),
    ];
}

function buildQuestionSection(question: string): Paragraph[] {
    return [
        h1('Your Question'),
        rule(C.emerald),
        new Paragraph({ spacing: { after: 120 } }),
        body(question),
        new Paragraph({ spacing: { after: 200 } }),
    ];
}

function buildResponseSection(response: string): Paragraph[] {
    return [
        h1('AI Response'),
        rule(C.emerald),
        new Paragraph({ spacing: { after: 120 } }),
        ...buildMarkdownParagraphs(response),
    ];
}

function buildSourcesSection(citations: unknown[]): Paragraph[] {
    const sources = citations
        .map(normalizeCitation)
        .filter((citation): citation is NormalizedCitation => citation !== null);

    if (sources.length === 0) {
        return [
            pageBreak(),
            h1('Sources / Citations'),
            rule(C.emerald),
            body('No source citations were stored for this query.', { italic: true }),
        ];
    }

    const nodes: Paragraph[] = [
        pageBreak(),
        h1('Sources / Citations'),
        rule(C.emerald),
    ];

    sources.forEach((citation, index) => {
        const authorityParts = [
            `Authority status: ${citation.authorityStatus.replace(/_/g, ' ')}`,
            `Binding status: ${citation.isBinding ? 'Binding' : 'Non-binding'}`,
        ];
        if (citation.score > 0) {
            authorityParts.push(`Relevance: ${Math.round(citation.score * 100)}%`);
        }

        nodes.push(
            boldBody(`${index + 1}. ${citation.documentTitle}${citation.version ? ` (${citation.version})` : ''}`),
            body(`Verification: ${verificationLabel(citation.verificationStatus)}`),
            body(authorityParts.join(' | ')),
        );

        if (citation.section) {
            nodes.push(body(`Section: ${citation.section}`));
        }
        if (citation.textSnippet) {
            nodes.push(body(`Snippet: ${citation.textSnippet}`, { italic: true }));
        }
        nodes.push(new Paragraph({ spacing: { after: 120 } }));
    });

    return nodes;
}

function buildDisclaimerSection(): Paragraph[] {
    return [
        pageBreak(),
        h1('Legal Disclaimer'),
        rule(),
        body(
            'This AI-generated response is for informational purposes only and should not be ' +
            'considered legal advice. Always consult with qualified legal professionals for ' +
            'specific compliance matters.',
        ),
        body(
            'Regulatory requirements may change; please verify against the latest versions of ' +
            'referenced legislation before making regulatory decisions.',
        ),
        new Paragraph({ spacing: { after: 200 } }),
        new Paragraph({
            children: [
                new TextRun({ text: 'SheriaBot ', font: 'Arial', size: 20, bold: true, color: C.navy }),
                new TextRun({
                    text: ' -  AI-Powered Regulatory Compliance for Kenya\'s Fintech Sector',
                    font: 'Arial',
                    size: 20,
                    color: C.slate,
                }),
            ],
            spacing: { after: 80 },
        }),
        new Paragraph({
            children: [
                new TextRun({
                    text: `Generated: ${new Date().toISOString()}`,
                    font: 'Arial',
                    size: 16,
                    color: C.slate,
                    italics: true,
                }),
            ],
        }),
    ];
}

// --- Input Types --------------------------------------------------------------

export interface ComplianceQueryExportParams {
    queryId: string;
    question: string;
    response: string;
    createdAt: Date;
    organizationName?: string;
    userName?: string;
    citations?: unknown[];
}

// --- Main Export Function -----------------------------------------------------

class ComplianceQueryExportService {
    /**
     * Generate a DOCX buffer for a compliance query Q&A.
     */
    async generateComplianceQueryDocx(params: ComplianceQueryExportParams): Promise<Buffer> {
        const startTime = Date.now();

        const coverNodes = buildCoverSection(params);
        const questionNodes = buildQuestionSection(params.question);
        const responseNodes = buildResponseSection(params.response);
        const sourcesNodes = buildSourcesSection(params.citations ?? []);
        const disclaimerNodes = buildDisclaimerSection();

        const allChildren = [...coverNodes, ...questionNodes, ...responseNodes, ...sourcesNodes, ...disclaimerNodes];

        const doc = new Document({
            styles: {
                default: {
                    document: { run: { font: 'Arial', size: 22 } },
                },
                paragraphStyles: [
                    {
                        id: 'Heading1',
                        name: 'Heading 1',
                        run: { font: 'Arial', size: 32, bold: true, color: C.navy },
                        paragraph: { spacing: { before: 240, after: 120 } },
                    },
                    {
                        id: 'Heading2',
                        name: 'Heading 2',
                        run: { font: 'Arial', size: 26, bold: true, color: C.emerald },
                        paragraph: { spacing: { before: 200, after: 80 } },
                    },
                ],
            },
            sections: [
                {
                    properties: {
                        page: {
                            size: { width: 11906, height: 16838 },
                            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
                        },
                    },
                    headers: {
                        default: buildHeader(params.organizationName),
                    },
                    footers: {
                        default: buildFooter(),
                    },
                    children: allChildren as unknown as any[],
                },
            ],
        });

        const buffer = await Packer.toBuffer(doc);

        logger.info({
            type: 'compliance_query_docx_generated',
            queryId: params.queryId,
            durationMs: Date.now() - startTime,
            sizeBytes: buffer.length,
        });

        return buffer;
    }

    /**
     * Sanitise a string for use as a filename component.
     * Matches the pattern used in checklist-export.service.ts.
     */
    sanitiseFilename(name: string): string {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    }
}

export const complianceQueryExportService = new ComplianceQueryExportService();
export { ComplianceQueryExportService };

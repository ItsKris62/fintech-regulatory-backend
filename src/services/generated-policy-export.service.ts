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
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { logger } from '@/utils/logger';

const CONTENT_W = 9026;

const C = {
  navy: '1A2B4A',
  emerald: '00875A',
  gold: 'D4A843',
  slate: '4A5568',
  muted: '6B7280',
  offWhite: 'F7F8FA',
  lightGreen: 'ECFDF5',
  white: 'FFFFFF',
} as const;

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'D1D5DB' } as const;
const ALL_BORDERS = {
  top: CELL_BORDER,
  bottom: CELL_BORDER,
  left: CELL_BORDER,
  right: CELL_BORDER,
} as const;

export interface GeneratedPolicyExportCitation {
  id: string;
  sectionId: string;
  actName: string;
  section: string;
  subsection: string | null;
  textSnippet: string;
  confidence: string;
  verified: boolean;
  citationVerified: boolean | null;
}

export interface GeneratedPolicyExportSection {
  id: string;
  title?: string;
  content?: unknown;
  contentMarkdown?: string;
  status?: string;
  wordCount?: number;
  editedAt?: string;
  editedByUserId?: string;
}

export interface GeneratedPolicyDocxParams {
  policyId: string;
  title: string;
  policyType: string;
  jurisdiction: string;
  organizationName: string;
  version: number;
  createdAt: Date;
  completedAt: Date | null;
  exportedAt: Date;
  exportedBy: string;
  executiveSummary: string | null;
  tableOfContents: unknown;
  sections: GeneratedPolicyExportSection[];
  citations: GeneratedPolicyExportCitation[];
  reviewNotes: string | null;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function formatDate(value: Date | null | undefined): string {
  return value ? value.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Not recorded';
}

function titleCase(value: string): string {
  return value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

function para(
  value: string,
  options: { bold?: boolean; color?: string; size?: number; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; italics?: boolean } = {},
): Paragraph {
  return new Paragraph({
    heading: options.heading,
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: value,
        bold: options.bold,
        italics: options.italics,
        color: options.color ?? C.slate,
        size: options.size ?? 22,
      }),
    ],
  });
}

function labelValue(label: string, value: string): Paragraph {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({ text: `${label}: `, bold: true, color: C.navy, size: 22 }),
      new TextRun({ text: value, color: C.slate, size: 22 }),
    ],
  });
}

function buildHeader(): Header {
  return new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({ text: 'SheriaBot Enterprise Compliance', bold: true, color: C.navy, size: 18 }),
        ],
      }),
    ],
  });
}

function buildFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: 'Confidential - Internal Use Only | Page ', color: C.muted, size: 18 }),
          new TextRun({ children: [PageNumber.CURRENT], color: C.muted, size: 18 }),
        ],
      }),
    ],
  });
}

function table(rows: Array<[string, string]>): Table {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: 2500, type: WidthType.DXA },
          borders: ALL_BORDERS,
          shading: { type: ShadingType.CLEAR, fill: C.offWhite },
          children: [para(label, { bold: true, color: C.navy })],
        }),
        new TableCell({
          width: { size: CONTENT_W - 2500, type: WidthType.DXA },
          borders: ALL_BORDERS,
          children: [para(value || 'Not recorded')],
        }),
      ],
    })),
  });
}

function tiptapText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) {
    return record.content.map(tiptapText).filter(Boolean).join(record.type === 'paragraph' ? '' : '\n');
  }
  return '';
}

function markdownFromSection(section: GeneratedPolicyExportSection): string {
  if (section.contentMarkdown && section.contentMarkdown.trim()) return section.contentMarkdown.trim();
  if (typeof section.content === 'string') return section.content.trim();
  const content = tiptapText(section.content);
  return content.trim();
}

function markdownParagraphs(markdown: string): Paragraph[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const nodes: Paragraph[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      nodes.push(new Paragraph({ spacing: { after: 80 } }));
      continue;
    }

    if (line.startsWith('### ')) {
      nodes.push(para(line.slice(4), { heading: HeadingLevel.HEADING_3, bold: true, color: C.navy, size: 24 }));
    } else if (line.startsWith('## ')) {
      nodes.push(para(line.slice(3), { heading: HeadingLevel.HEADING_2, bold: true, color: C.emerald, size: 26 }));
    } else if (line.startsWith('# ')) {
      nodes.push(para(line.slice(2), { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }));
    } else if (/^[-*]\s+/.test(line)) {
      nodes.push(new Paragraph({
        bullet: { level: 0 },
        spacing: { after: 80 },
        children: [new TextRun({ text: line.replace(/^[-*]\s+/, ''), color: C.slate, size: 22 })],
      }));
    } else if (/^\d+\.\s+/.test(line)) {
      nodes.push(para(line, { color: C.slate }));
    } else {
      nodes.push(para(line));
    }
  }

  return nodes.length ? nodes : [para('No content recorded for this section.', { italics: true, color: C.muted })];
}

function sectionCitations(sectionId: string, citations: GeneratedPolicyExportCitation[]): Paragraph[] {
  const matches = citations.filter((citation) => citation.sectionId === sectionId);
  if (!matches.length) {
    return [para('No citations recorded for this section.', { italics: true, color: C.muted })];
  }

  return matches.flatMap((citation, index) => [
    para(`${index + 1}. ${citation.actName}${citation.section ? ` - ${citation.section}` : ''}`, {
      bold: true,
      color: C.navy,
    }),
    para(citation.textSnippet),
    para(
      `Confidence: ${titleCase(citation.confidence)} | Verified: ${citation.verified || citation.citationVerified ? 'Yes' : 'No'}`,
      { color: C.muted, size: 18 },
    ),
  ]);
}

function tocSections(tableOfContents: unknown, sections: GeneratedPolicyExportSection[]): string[] {
  if (tableOfContents && typeof tableOfContents === 'object') {
    const maybeSections = (tableOfContents as Record<string, unknown>).sections;
    if (Array.isArray(maybeSections)) {
      return maybeSections
        .map((item) => text((item as Record<string, unknown>)?.title))
        .filter(Boolean);
    }
  }
  return sections.map((section) => text(section.title, section.id));
}

function buildCover(params: GeneratedPolicyDocxParams): Array<Paragraph | Table> {
  return [
    new Paragraph({
      spacing: { after: 260 },
      children: [new TextRun({ text: 'SheriaBot', bold: true, color: C.emerald, size: 44 })],
    }),
    para(params.title, { heading: HeadingLevel.TITLE, bold: true, color: C.navy, size: 42 }),
    para('Enterprise AI Policy Generator', { color: C.gold, bold: true, size: 24 }),
    table([
      ['Organization', params.organizationName],
      ['Policy Type', titleCase(params.policyType)],
      ['Jurisdiction', params.jurisdiction],
      ['Policy Version', `v${params.version}`],
      ['Generated', formatDate(params.completedAt ?? params.createdAt)],
      ['Exported', formatDate(params.exportedAt)],
    ]),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

function buildDisclaimer(): Paragraph[] {
  return [
    para('Legal and Compliance Disclaimer', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }),
    para(
      'This AI-generated policy is provided for compliance support and operational review. It does not replace independent legal advice, board review, regulator guidance, or professional judgement by qualified counsel.',
    ),
  ];
}

class GeneratedPolicyExportService {
  async generateDocx(params: GeneratedPolicyDocxParams): Promise<Buffer> {
    const startTime = Date.now();
    const children: Array<Paragraph | Table> = [
      ...buildCover(params),
      ...buildDisclaimer(),
      para('Executive Summary', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }),
      para(params.executiveSummary ?? 'No executive summary was generated for this policy.'),
      para('Table of Contents', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }),
      ...tocSections(params.tableOfContents, params.sections).map((title, index) => para(`${index + 1}. ${title}`)),
      para('Policy Sections', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }),
    ];

    params.sections.forEach((section, index) => {
      children.push(para(`${index + 1}. ${text(section.title, section.id)}`, {
        heading: HeadingLevel.HEADING_2,
        bold: true,
        color: C.emerald,
        size: 28,
      }));
      children.push(labelValue('Section status', titleCase(section.status ?? 'DRAFT')));
      children.push(...markdownParagraphs(markdownFromSection(section)));
      children.push(para('Citations', { heading: HeadingLevel.HEADING_3, bold: true, color: C.navy, size: 24 }));
      children.push(...sectionCitations(section.id, params.citations));
    });

    children.push(para('Reviewer Notes', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }));
    children.push(para(params.reviewNotes ?? 'No reviewer notes were recorded for this policy.'));
    children.push(para('Export Metadata', { heading: HeadingLevel.HEADING_1, bold: true, color: C.navy, size: 30 }));
    children.push(table([
      ['Exported By', params.exportedBy],
      ['Exported At', params.exportedAt.toISOString()],
      ['Source Policy ID', params.policyId],
      ['Version', `v${params.version}`],
      ['Format', 'DOCX'],
    ]));

    const doc = new Document({
      styles: {
        default: { document: { run: { font: 'Arial', size: 22 } } },
      },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: { default: buildHeader() },
        footers: { default: buildFooter() },
        children,
      }],
    });

    const buffer = await Packer.toBuffer(doc);

    logger.info({
      type: 'generated_policy_docx_generated',
      policyId: params.policyId,
      sectionCount: params.sections.length,
      citationCount: params.citations.length,
      sizeBytes: buffer.length,
      durationMs: Date.now() - startTime,
    });

    return buffer;
  }

  sanitiseFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 60);
  }
}

export const generatedPolicyExportService = new GeneratedPolicyExportService();
export { GeneratedPolicyExportService };

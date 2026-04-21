/**
 * Checklist DOCX Export Service
 *
 * Generates a professional Word document from a normalized ComplianceChecklist
 * with all its ChecklistItem rows. Uses the `docx` npm package (v9).
 *
 * Critical docx rules (same as gap-analysis-export.service.ts):
 *   - WidthType.DXA everywhere (never PERCENTAGE  -  breaks Google Docs)
 *   - ShadingType.CLEAR (never SOLID  -  causes black cell backgrounds)
 *   - No \n inside TextRun  -  use separate Paragraphs
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
  LevelFormat,
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

// --- Constants ----------------------------------------------------------------

/** A4 content width in DXA (11906 - 2*1440). */
const CONTENT_W = 9026;

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } as const;
const ALL_BORDERS = {
  top: CELL_BORDER, bottom: CELL_BORDER,
  left: CELL_BORDER, right: CELL_BORDER,
} as const;

// Brand colours
const C = {
  navy:      '1A2B4A',
  emerald:   '00875A',
  gold:      'D4A843',
  slate:     '4A5568',
  offWhite:  'F7F8FA',
  white:     'FFFFFF',
  criticalBg: 'FEE2E2',
  highBg:     'FEF3C7',
  mediumBg:   'FEFCE8',
  lowBg:      'F0FDF4',
  criticalTx: 'DC2626',
  highTx:     'EA580C',
  mediumTx:   'CA8A04',
  lowTx:      '16A34A',
  completedBg: 'DCFCE7',
  completedTx: '15803D',
  pendingTx:   '6B7280',
  inProgressTx: '1D4ED8',
  naBg:       'F3F4F6',
  naTx:       '9CA3AF',
} as const;

// --- Input Types --------------------------------------------------------------

export interface ChecklistItemExport {
  id:                  string;
  itemCode:            string | null;
  category:            string;
  title:               string;
  description:         string;
  guidance:            string | null;
  regulatoryReference: string;
  actionItems:         string[];
  deadline:            string | null;
  penalty:             string | null;
  priority:            string;
  status:              string;
  notes:               string | null;
  completedAt:         Date | null;
}

export interface ChecklistExportParams {
  checklistId:   string;
  title:         string;
  productType:   string | null;
  businessStage: string | null;
  progress:      number;
  completedItems: number;
  totalItems:    number;
  generatedAt:   Date | null;
  createdAt:     Date;
  summary: {
    criticalItems?: number;
    highItems?:     number;
    estimatedCompletionDays?: number;
  } | null;
  categories: Array<{
    name:           string;
    items:          ChecklistItemExport[];
    completedCount: number;
    totalCount:     number;
  }>;
  organizationName?: string;
  userName?:         string;
}

// --- Helpers ------------------------------------------------------------------

function s(v: string | null | undefined): string { return v ?? '' }

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function priorityBg(p: string): string {
  switch (p) {
    case 'CRITICAL': return C.criticalBg;
    case 'HIGH':     return C.highBg;
    case 'MEDIUM':   return C.mediumBg;
    case 'LOW':      return C.lowBg;
    default:         return C.offWhite;
  }
}

function priorityColor(p: string): string {
  switch (p) {
    case 'CRITICAL': return C.criticalTx;
    case 'HIGH':     return C.highTx;
    case 'MEDIUM':   return C.mediumTx;
    case 'LOW':      return C.lowTx;
    default:         return C.slate;
  }
}

function statusLabel(s: string): string {
  switch (s) {
    case 'COMPLETED':      return 'Completed';
    case 'IN_PROGRESS':    return 'In Progress';
    case 'NOT_APPLICABLE': return 'N/A';
    default:               return 'Pending';
  }
}

function statusColor(st: string): string {
  switch (st) {
    case 'COMPLETED':      return C.completedTx;
    case 'IN_PROGRESS':    return C.inProgressTx;
    case 'NOT_APPLICABLE': return C.naTx;
    default:               return C.pendingTx;
  }
}

function statusBg(st: string): string {
  switch (st) {
    case 'COMPLETED':      return C.completedBg;
    case 'NOT_APPLICABLE': return C.naBg;
    default:               return C.white;
  }
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

function body(text: string, opts: { color?: string; italic?: boolean } = {}): Paragraph {
  return new Paragraph({
    children: [new TextRun({
      text,
      font: 'Arial',
      size: 22,
      color: opts.color ?? C.slate,
      italics: opts.italic,
    })],
    spacing: { after: 120 },
  });
}

function cell(
  text: string,
  width: number,
  opts: { bg?: string; bold?: boolean; color?: string; size?: number; centered?: boolean } = {},
): TableCell {
  const { bg = C.white, bold = false, color = C.slate, size = 18, centered = false } = opts;
  return new TableCell({
    borders: ALL_BORDERS,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: bg, type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [new Paragraph({
      alignment: centered ? AlignmentType.CENTER : AlignmentType.LEFT,
      children: [new TextRun({ text: s(text), font: 'Arial', size, bold, color })],
    })],
  });
}

function multiLineCell(lines: string[], width: number, opts: { bg?: string; color?: string } = {}): TableCell {
  const { bg = C.white, color = C.slate } = opts;
  const children: Paragraph[] = lines.length === 0
    ? [new Paragraph({ children: [new TextRun({ text: '\u2014', font: 'Arial', size: 18, color })] })]
    : lines.map((line, i) => new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${s(line)}`, font: 'Arial', size: 18, color })],
        spacing: { after: 40 },
      }));
  return new TableCell({
    borders: ALL_BORDERS,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: bg, type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children,
  });
}

// --- Section builders ---------------------------------------------------------

function buildHeader(params: ChecklistExportParams): Header {
  const displayName = params.organizationName ?? params.userName ?? 'SheriaBot';
  return new Header({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: 'SheriaBot', font: 'Arial', size: 18, bold: true, color: C.navy }),
          new TextRun({ text: `  |  Compliance Checklist  |  ${displayName}`, font: 'Arial', size: 18, color: C.slate }),
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
          new TextRun({ text: 'Confidential  -  For Internal Use Only  |  ', font: 'Arial', size: 16, color: C.slate }),
          new TextRun({ text: 'Page ', font: 'Arial', size: 16, color: C.slate }),
          new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: C.slate }),
          new TextRun({ text: '  |  sheriabot.com', font: 'Arial', size: 16, color: C.slate }),
        ],
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.navy } },
        spacing: { before: 60 },
      }),
    ],
  });
}

function buildCoverSection(params: ChecklistExportParams): (Paragraph | Table)[] {
  const { title, productType, businessStage, generatedAt, createdAt, organizationName, userName,
          progress, completedItems, totalItems, summary } = params;
  const displayName = organizationName ?? userName ?? 'Your Organisation';
  const dateStr = formatDate(generatedAt ?? createdAt);

  return [
    new Paragraph({
      children: [new TextRun({ text: 'SHERIABOT', font: 'Arial', size: 48, bold: true, color: C.navy })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 160 },
    }),
    new Paragraph({
      children: [new TextRun({ text: 'Compliance Checklist Report', font: 'Arial', size: 36, color: C.emerald })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: title, font: 'Arial', size: 28, bold: true, color: C.navy })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
    rule(C.gold),

    // Metadata table
    new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      rows: [
        new TableRow({ children: [
          cell('Organisation', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(displayName, CONTENT_W / 2, { size: 20 }),
        ]}),
        new TableRow({ children: [
          cell('Product / Service', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(s(productType), CONTENT_W / 2, { size: 20 }),
        ]}),
        new TableRow({ children: [
          cell('Business Stage', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(s(businessStage), CONTENT_W / 2, { size: 20 }),
        ]}),
        new TableRow({ children: [
          cell('Generated On', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(dateStr, CONTENT_W / 2, { size: 20 }),
        ]}),
        new TableRow({ children: [
          cell('Overall Progress', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(`${progress}% (${completedItems} of ${totalItems} items completed)`, CONTENT_W / 2, { size: 20 }),
        ]}),
        new TableRow({ children: [
          cell('Critical Items', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(String(summary?.criticalItems ?? 0), CONTENT_W / 2, { size: 20, color: C.criticalTx }),
        ]}),
        new TableRow({ children: [
          cell('High Priority Items', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(String(summary?.highItems ?? 0), CONTENT_W / 2, { size: 20, color: C.highTx }),
        ]}),
        ...(summary?.estimatedCompletionDays ? [new TableRow({ children: [
          cell('Estimated Compliance Timeline', CONTENT_W / 2, { bg: C.offWhite, bold: true, color: C.navy, size: 20 }),
          cell(`${summary.estimatedCompletionDays} days`, CONTENT_W / 2, { size: 20 }),
        ]})] : []),
      ],
    }),

    new Paragraph({ spacing: { after: 200 } }),
    new Paragraph({
      children: [new TextRun({
        text: 'This checklist was generated by SheriaBot AI based on Kenyan regulatory requirements and international standards. It should be reviewed by qualified legal and compliance professionals.',
        font: 'Arial', size: 18, color: C.slate, italics: true,
      })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
    }),
    pageBreak(),
  ];
}

// Category column widths. Total must equal CONTENT_W (9026).
// Code | Title | Status | Priority | Regulatory Ref | Action Items | Deadline | Penalty
const COL = {
  code:    500,
  title:   1700,
  status:  700,
  priority: 700,
  regRef:  1500,
  actions: 1500,
  deadline: 900,
  penalty: 1526,
} as const;
// 500+1700+700+700+1500+1500+900+1526 = 9026 ✓

function buildCategorySection(cat: ChecklistExportParams['categories'][0]): Array<Paragraph | Table> {
  const nodes: Array<Paragraph | Table> = [];

  // Category heading
  nodes.push(new Paragraph({
    children: [new TextRun({ text: cat.name, font: 'Arial', size: 26, bold: true, color: C.navy })],
    spacing: { before: 240, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.emerald } },
  }));

  nodes.push(new Paragraph({
    children: [new TextRun({
      text: `${cat.completedCount} of ${cat.totalCount} items completed`,
      font: 'Arial', size: 18, color: C.slate, italics: true,
    })],
    spacing: { after: 120 },
  }));

  // Items table header
  const headerRow = new TableRow({
    tableHeader: true,
    children: [
      cell('Code',          COL.code,     { bg: C.navy, bold: true, color: C.white, size: 16, centered: true }),
      cell('Requirement',   COL.title,    { bg: C.navy, bold: true, color: C.white, size: 16 }),
      cell('Status',        COL.status,   { bg: C.navy, bold: true, color: C.white, size: 16, centered: true }),
      cell('Priority',      COL.priority, { bg: C.navy, bold: true, color: C.white, size: 16, centered: true }),
      cell('Regulatory Ref', COL.regRef,  { bg: C.navy, bold: true, color: C.white, size: 16 }),
      cell('Action Items',  COL.actions,  { bg: C.navy, bold: true, color: C.white, size: 16 }),
      cell('Deadline',      COL.deadline, { bg: C.navy, bold: true, color: C.white, size: 16 }),
      cell('Penalty',       COL.penalty,  { bg: C.navy, bold: true, color: C.white, size: 16 }),
    ],
  });

  const dataRows = cat.items.map((item) => {
    const pBg  = priorityBg(item.priority);
    const pCol = priorityColor(item.priority);
    const sBg  = statusBg(item.status);
    const sCol = statusColor(item.status);
    const actionLines = Array.isArray(item.actionItems) ? item.actionItems : [];

    return new TableRow({
      children: [
        cell(s(item.itemCode), COL.code,     { centered: true, size: 16, color: C.slate }),
        // Title + description stacked
        new TableCell({
          borders: ALL_BORDERS,
          width: { size: COL.title, type: WidthType.DXA },
          shading: { fill: sBg, type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 100, right: 100 },
          children: [
            new Paragraph({
              children: [new TextRun({ text: s(item.title), font: 'Arial', size: 18, bold: true,
                color: item.status === 'COMPLETED' ? C.slate : C.navy })],
              spacing: { after: 40 },
            }),
            new Paragraph({
              children: [new TextRun({ text: s(item.description), font: 'Arial', size: 16, color: C.slate,
                italics: item.status === 'NOT_APPLICABLE' })],
              spacing: { after: item.guidance ? 40 : 0 },
            }),
            ...(item.guidance ? [new Paragraph({
              children: [new TextRun({ text: `\uD83D\uDCA1 ${s(item.guidance)}`, font: 'Arial', size: 15,
                color: '1D4ED8', italics: true })],
            })] : []),
            ...(item.notes ? [new Paragraph({
              children: [new TextRun({ text: `\uD83D\uDCDD ${s(item.notes)}`, font: 'Arial', size: 15,
                color: C.gold })],
            })] : []),
          ],
        }),
        cell(statusLabel(item.status), COL.status,   { bg: sBg, color: sCol, centered: true, size: 16 }),
        cell(item.priority,            COL.priority, { bg: pBg, color: pCol, bold: true, centered: true, size: 16 }),
        cell(s(item.regulatoryReference), COL.regRef, { size: 16 }),
        multiLineCell(actionLines,     COL.actions),
        cell(s(item.deadline),         COL.deadline, { size: 16 }),
        cell(s(item.penalty),          COL.penalty,  { size: 15 }),
      ],
    });
  });

  nodes.push(new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    rows: [headerRow, ...dataRows],
  }));

  nodes.push(new Paragraph({ spacing: { after: 160 } }));

  return nodes;
}

function buildDisclaimerSection(): Paragraph[] {
  return [
    pageBreak(),
    h1('Disclaimer'),
    rule(),
    body(
      'This compliance checklist was generated by SheriaBot using AI-powered analysis of Kenyan financial ' +
      'services regulations. While every effort has been made to ensure accuracy, this document should not ' +
      'be considered legal advice. Organizations should consult with qualified legal and compliance ' +
      'professionals to verify all requirements.'
    ),
    body(
      'Regulatory requirements may change; please verify against the latest versions of referenced ' +
      'legislation before making regulatory decisions.'
    ),
    new Paragraph({ spacing: { after: 200 } }),
    new Paragraph({
      children: [
        new TextRun({ text: 'SheriaBot ', font: 'Arial', size: 20, bold: true, color: C.navy }),
        new TextRun({ text: ' -  AI-Powered Regulatory Compliance for Kenya\'s Fintech Sector', font: 'Arial', size: 20, color: C.slate }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({
        text: `Generated: ${new Date().toISOString()}`,
        font: 'Arial', size: 16, color: C.slate, italics: true,
      })],
    }),
  ];
}

// --- Main Export Function -----------------------------------------------------

class ChecklistExportService {
  /**
   * Generate a DOCX buffer from a normalized compliance checklist.
   */
  async generateChecklistDocx(params: ChecklistExportParams): Promise<Buffer> {
    const startTime = Date.now();

    const coverNodes   = buildCoverSection(params);
    const categoryNodes = params.categories.flatMap((cat) => buildCategorySection(cat));
    const disclaimer   = buildDisclaimerSection();

    const allChildren = [...coverNodes, ...categoryNodes, ...disclaimer];

    const doc = new Document({
      numbering: {
        config: [{
          reference: 'bullets',
          levels: [{
            level: 0,
            format: LevelFormat.BULLET,
            text: '\u2022',
            alignment: AlignmentType.LEFT,
            style: {
              paragraph: { indent: { left: 360, hanging: 180 } },
              run: { font: 'Symbol' },
            },
          }],
        }],
      },
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
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
          },
        },
        headers: { default: buildHeader(params) },
        footers: { default: buildFooter() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        children: allChildren as unknown as any[],
      }],
    });

    const buffer = await Packer.toBuffer(doc);

    logger.info({
      type:          'checklist_docx_generated',
      checklistId:   params.checklistId,
      totalItems:    params.totalItems,
      categories:    params.categories.length,
      durationMs:    Date.now() - startTime,
      sizeBytes:     buffer.length,
    });

    return buffer;
  }

  /**
   * Sanitise a string for use as a filename component.
   * Matches the pattern used in gap-analysis-export.service.ts.
   */
  sanitiseFilename(name: string): string {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  }
}

export const checklistExportService = new ChecklistExportService();
export { ChecklistExportService };

/**
 * Gap Analysis DOCX Export Service
 *
 * Generates a professional Word document from a validated GapAnalysisResult.
 * Uses the `docx` npm package (v9). All text is passed through TextRun which
 * escapes content natively  -  never use raw HTML or markdown injection.
 *
 * Critical docx rules observed:
 *   - WidthType.DXA everywhere (never PERCENTAGE  -  breaks Google Docs)
 *   - ShadingType.CLEAR (never SOLID  -  causes black cell backgrounds)
 *   - LevelFormat.BULLET for bullet lists (no raw unicode bullets in TextRun)
 *   - No \n inside TextRun  -  use separate Paragraphs
 *   - PageBreak must be inside a Paragraph
 *   - Tables never used in headers/footers  -  use tab stops instead
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
  TableOfContents,
  TableRow,
  TabStopPosition,
  TabStopType,
  TextRun,
  WidthType,
} from 'docx';
import type { GapAnalysisResult, GapItem, ActionPlanItem } from '@/lib/ai/prompts/gap-analysis';

// --- Constants ----------------------------------------------------------------

/** A4 content width in DXA (11906 - 2*1440). */
const CONTENT_W = 9026;

/** Standard cell border applied to all table cells. */
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' } as const;
const ALL_BORDERS = {
  top: CELL_BORDER, bottom: CELL_BORDER,
  left: CELL_BORDER, right: CELL_BORDER,
} as const;

// Brand colours (hex strings without #)
const C = {
  navy:      '1A2B4A',
  emerald:   '00875A',
  gold:      'D4A843',
  slate:     '4A5568',
  offWhite:  'F7F8FA',
  white:     'FFFFFF',
  criticalBg: 'FEE2E2',
  highBg:     'FEF3C7',
  mediumBg:   'FEF9C3',
  lowBg:      'DBEAFE',
  criticalTx: 'DC2626',
  highTx:     'D97706',
  mediumTx:   'CA8A04',
  lowTx:      '2563EB',
} as const;

// --- Parameter type -----------------------------------------------------------

export interface DocxExportParams {
  result: GapAnalysisResult;
  analysisId: string;
  documentName: string;
  regulatoryFrameworks: string[];
  analysisDepth: string;
  ragGrounded: boolean;
  chunksProcessed: number;
  createdAt: Date;
  organizationName?: string;
  userName?: string;
}

// --- Helpers ------------------------------------------------------------------

function scoreColor(score: number): string {
  if (score >= 75) return C.emerald;
  if (score >= 50) return C.gold;
  return C.criticalTx;
}

function severityBg(sev: string): string {
  switch (sev) {
    case 'CRITICAL': return C.criticalBg;
    case 'HIGH':     return C.highBg;
    case 'MEDIUM':   return C.mediumBg;
    case 'LOW':      return C.lowBg;
    default:         return C.offWhite;
  }
}

function severityColor(sev: string): string {
  switch (sev) {
    case 'CRITICAL': return C.criticalTx;
    case 'HIGH':     return C.highTx;
    case 'MEDIUM':   return C.mediumTx;
    case 'LOW':      return C.lowTx;
    default:         return C.slate;
  }
}

function formatDepth(depth: string): string {
  switch (depth) {
    case 'quick': return 'Quick Scan';
    case 'deep':  return 'Deep Analysis';
    default:      return 'Standard Analysis';
  }
}

function formatDate(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Safe string  -  never undefined. */
function s(v: string | undefined | null): string {
  return v ?? '';
}

/** Heading 1 paragraph using the override style. */
function h1(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
}

/** Heading 2 paragraph. */
function h2(text: string): Paragraph {
  return new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
}

/** Body paragraph in Slate Gray. */
function body(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, font: 'Arial', size: 22, color: C.slate })],
    spacing: { after: 120 },
  });
}

/** Bullet-list paragraph using the "bullets" numbering reference. */
function bullet(text: string, reference = 'bullets'): Paragraph {
  return new Paragraph({
    numbering: { reference, level: 0 },
    children: [new TextRun({ text: s(text), font: 'Arial', size: 20, color: C.slate })],
  });
}

/** Ballot-box (evidence checklist) bullet paragraph. */
function checkBullet(text: string): Paragraph {
  return bullet(text, 'evidence-checklist');
}

/** Mandatory page break  -  must be inside a Paragraph. */
function pageBreak(): Paragraph {
  return new Paragraph({ children: [new PageBreak()] });
}

/** Horizontal rule via bottom border on an empty paragraph. */
function rule(color = C.navy): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color, space: 1 },
    },
    spacing: { after: 160 },
  });
}

/** Simple two-cell table row for methodology table. */
function methodRow(label: string, value: string): TableRow {
  const cellBase = (text: string, bold = false, bg: string = C.offWhite) =>
    new TableCell({
      borders: ALL_BORDERS,
      width: { size: CONTENT_W / 2, type: WidthType.DXA },
      shading: { fill: bg, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({
        children: [new TextRun({ text, font: 'Arial', size: 20, bold, color: bold ? C.navy : C.slate })],
      })],
    });

  return new TableRow({ children: [cellBase(label, true), cellBase(value, false, C.white)] });
}

/** Header row for the gaps table (Dark Navy bg, white text). */
function gapHeaderRow(cols: Array<{ label: string; width: number }>): TableRow {
  return new TableRow({
    tableHeader: true,
    children: cols.map((col) =>
      new TableCell({
        borders: ALL_BORDERS,
        width: { size: col.width, type: WidthType.DXA },
        shading: { fill: C.navy, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 100, right: 100 },
        children: [new Paragraph({
          children: [new TextRun({ text: col.label, font: 'Arial', size: 18, bold: true, color: C.white })],
        })],
      })
    ),
  });
}

/** Single-line cell. */
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

/** Multi-paragraph cell (used for evidence list). */
function evidenceCell(items: string[], width: number): TableCell {
  const children: Paragraph[] =
    items.length === 0
      ? [new Paragraph({ children: [new TextRun({ text: '\u2014', font: 'Arial', size: 18, color: C.slate })] })]
      : items.map((item) => new Paragraph({
          children: [new TextRun({ text: `- ${s(item)}`, font: 'Arial', size: 16, color: C.slate })],
          spacing: { after: 40 },
        }));

  return new TableCell({
    borders: ALL_BORDERS,
    width: { size: width, type: WidthType.DXA },
    shading: { fill: C.white, type: ShadingType.CLEAR },
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children,
  });
}

// --- Gap table columns --------------------------------------------------------
// Total must equal CONTENT_W (9026)
const GAP_COLS = [
  { label: '#',            width: 320  },
  { label: 'Gap Title',   width: 1400 },
  { label: 'Severity',    width: 700  },
  { label: 'Reg. Ref.',   width: 1100 },
  { label: 'Current State', width: 1100 },
  { label: 'Recommendation', width: 1100 },
  { label: 'Evidence',    width: 1100 },
  { label: 'Owner',       width: 706  },
  { label: 'Effort',      width: 500  },
  { label: 'Pri.',        width: 300  },
  // Total: 320+1400+700+1100+1100+1100+1100+706+500+300 = 8326. Add to Reg.Ref. -> 1800 - diff
] as const;
// Recalc: 320+1400+700+1800+1100+1100+1100+706+500+300 = 9026  -  adjust Reg.Ref. to 1800
const GAP_COL_WIDTHS = [320, 1400, 700, 1800, 1100, 1100, 1100, 706, 500, 300] as const;

const ACTION_COL_WIDTHS = [600, 2200, 1000, 1000, 1500, 726, 2000] as const;
// Total: 600+2200+1000+1000+1500+726+2000 = 9026

// --- Section builders ---------------------------------------------------------

function buildCoverSection(params: DocxExportParams): object {
  const { result, documentName, analysisDepth, createdAt, organizationName, userName } = params;
  const displayName = organizationName ?? userName ?? 'Your Organisation';
  const dateStr = formatDate(createdAt);
  const sc = scoreColor(result.overallScore);

  const children: Paragraph[] = [
    // Brand header
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 400 },
      children: [new TextRun({ text: 'SheriaBot', font: 'Arial', size: 48, bold: true, color: C.navy })],
    }),
    // CONFIDENTIAL banner
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { fill: C.navy, type: ShadingType.CLEAR },
      spacing: { before: 200, after: 200 },
      children: [
        new TextRun({ text: 'CONFIDENTIAL', font: 'Arial', size: 28, bold: true, color: C.gold }),
      ],
    }),
    // Report title
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 400, after: 200 },
      children: [
        new TextRun({ text: 'Regulatory Compliance Gap Analysis Report', font: 'Arial', size: 56, bold: true, color: C.navy }),
      ],
    }),
    // Subtitle
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 400 },
      children: [
        new TextRun({ text: `Prepared for ${displayName}`, font: 'Arial', size: 32, color: C.slate }),
      ],
    }),
    // Overall score
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 160 },
      children: [
        new TextRun({ text: 'Overall Compliance Score: ', font: 'Arial', size: 28, color: C.slate }),
        new TextRun({ text: String(result.overallScore), font: 'Arial', size: 96, bold: true, color: sc }),
        new TextRun({ text: '/100', font: 'Arial', size: 36, color: C.slate }),
      ],
    }),
    // Score label
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 400 },
      children: [
        new TextRun({ text: result.overallScore >= 75 ? 'Good' : result.overallScore >= 50 ? 'Needs Work' : 'Critical Risk', font: 'Arial', size: 28, color: sc }),
      ],
    }),
    // Meta info
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: `Document: ${documentName}`, font: 'Arial', size: 22, color: C.slate })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: `Analysis Type: ${formatDepth(analysisDepth)}`, font: 'Arial', size: 22, color: C.slate })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [new TextRun({ text: `Date: ${dateStr}`, font: 'Arial', size: 22, color: C.slate })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new TextRun({ text: `Report ID: ${params.analysisId}`, font: 'Arial', size: 18, color: C.slate })],
    }),
    // Frameworks
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 200, after: 120 },
      children: [new TextRun({ text: 'Frameworks Analysed:', font: 'Arial', size: 22, bold: true, color: C.navy })],
    }),
    ...result.frameworks.map((fw) =>
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
        children: [new TextRun({ text: fw.name, font: 'Arial', size: 22, color: C.emerald })],
      })
    ),
    // Legal Disclaimer
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { fill: 'FEF3C7', type: ShadingType.CLEAR },
      border: {
        top: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
        left: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
        right: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
      },
      spacing: { before: 400, after: 200 },
      children: [
        new TextRun({ text: 'DISCLAIMER', font: 'Arial', size: 20, bold: true, color: C.gold }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { fill: 'FEF3C7', type: ShadingType.CLEAR },
      border: {
        left: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
        right: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: C.gold, space: 1 },
      },
      spacing: { after: 200 },
      children: [
        new TextRun({
          text: 'This Gap Analysis Report was generated by SheriaBot AI for informational and internal auditing purposes only. It does not constitute formal legal advice. Organisations should consult with qualified legal counsel before making compliance decisions based on this report.',
          font: 'Arial', size: 18, color: C.slate, italics: true,
        }),
      ],
    }),
    // Footer line
    new Paragraph({
      alignment: AlignmentType.CENTER,
      border: { top: { style: BorderStyle.SINGLE, size: 4, color: C.navy, space: 1 } },
      spacing: { before: 400 },
      children: [
        new TextRun({ text: `Generated by SheriaBot | sheriabot.com | ${dateStr}`, font: 'Arial', size: 18, color: C.slate }),
      ],
    }),
  ];

  return {
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children,
  };
}

function buildMainSection(params: DocxExportParams): object {
  const { result, analysisId, documentName, analysisDepth, ragGrounded, chunksProcessed, createdAt, organizationName, userName } = params;
  const { executiveSummary, frameworks, actionPlan, metadata } = result;
  const displayName = organizationName ?? userName ?? 'Your Organisation';
  const dateStr = formatDate(createdAt);

  const children: Paragraph[] = [];

  // -- Table of Contents ----------------------------------------------------
  children.push(
    new Paragraph({ heading: HeadingLevel.HEADING_1, text: 'Table of Contents' }),
    // @ts-expect-error  -  TableOfContents is a valid Document child but typed as Paragraph in some docx versions
    new TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-3' }),
    pageBreak(),
  );

  // -- Executive Summary ----------------------------------------------------
  children.push(h1('Executive Summary'), rule());

  if (!ragGrounded) {
    children.push(
      new Paragraph({
        shading: { fill: 'FEF3C7', type: ShadingType.CLEAR },
        spacing: { before: 120, after: 200 },
        children: [
          new TextRun({ text: 'Warning: Limited Regulatory Grounding. ', font: 'Arial', size: 20, bold: true, color: C.gold }),
          new TextRun({
            text: 'This analysis was generated without access to the SheriaBot regulatory document database. Results are based on AI training knowledge only.',
            font: 'Arial', size: 20, color: C.slate,
          }),
        ],
      }),
    );
  }

  // Executive summary paragraphs
  executiveSummary.split(/\n\n+/).filter((p) => p.trim()).forEach((para) => {
    children.push(body(para.trim()));
  });

  // Key metrics table (1 row, 5 cells)
  children.push(
    new Paragraph({ text: 'Key Metrics', heading: HeadingLevel.HEADING_2, spacing: { before: 240 } }),
    new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [1805, 1805, 1806, 1805, 1805],
      rows: [
        new TableRow({ children: [
          cell('Total Gaps',    1805, { bg: C.offWhite, bold: true, color: C.navy }),
          cell('Critical',      1805, { bg: C.criticalBg, bold: true, color: C.criticalTx }),
          cell('High',          1806, { bg: C.highBg, bold: true, color: C.highTx }),
          cell('Medium',        1805, { bg: C.mediumBg, bold: true, color: C.mediumTx }),
          cell('Low',           1805, { bg: C.lowBg, bold: true, color: C.lowTx }),
        ]}),
        new TableRow({ children: [
          cell(String(metadata.totalGaps),    1805, { bg: C.offWhite, bold: true, size: 32, centered: true }),
          cell(String(metadata.criticalGaps), 1805, { bg: C.criticalBg, bold: true, size: 32, color: C.criticalTx, centered: true }),
          cell(String(metadata.highGaps),     1806, { bg: C.highBg, bold: true, size: 32, color: C.highTx, centered: true }),
          cell(String(metadata.mediumGaps ?? 0), 1805, { bg: C.mediumBg, bold: true, size: 32, color: C.mediumTx, centered: true }),
          cell(String(metadata.lowGaps ?? 0), 1805, { bg: C.lowBg, bold: true, size: 32, color: C.lowTx, centered: true }),
        ]}),
      ],
    }) as unknown as Paragraph,
    pageBreak(),
  );

  // -- Methodology ----------------------------------------------------------
  children.push(h1('Methodology'), rule());

  const methodRows: TableRow[] = [
    methodRow('Document Analysed',       documentName),
    methodRow('Analysis Date',           dateStr),
    methodRow('Analysis Depth',          formatDepth(analysisDepth)),
    methodRow('Chunks Processed',        `${chunksProcessed} ${chunksProcessed > 1 ? '(Full document multi-pass)' : '(Single-pass)'}`),
    methodRow('Frameworks Assessed',     frameworks.map((f) => f.name).join(', ')),
    methodRow('Regulatory Grounding',    ragGrounded ? 'Grounded in SheriaBot regulatory document database' : 'Warning: Limited grounding - AI knowledge only'),
    methodRow('Report ID',               analysisId),
  ];

  children.push(
    new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [CONTENT_W / 2, CONTENT_W / 2],
      rows: methodRows,
    }) as unknown as Paragraph,
  );

  // Disclaimer box
  children.push(
    new Paragraph({
      shading: { fill: 'FFFBEB', type: ShadingType.CLEAR },
      border: { top: CELL_BORDER, bottom: CELL_BORDER, left: { style: BorderStyle.SINGLE, size: 4, color: C.gold }, right: CELL_BORDER },
      spacing: { before: 240, after: 240 },
      children: [
        new TextRun({ text: 'Important Disclaimer: ', font: 'Arial', size: 20, bold: true, color: C.gold }),
        new TextRun({
          text: 'This report is generated by AI-assisted analysis and should be reviewed by qualified compliance professionals before being used for regulatory submissions. SheriaBot does not provide legal advice.',
          font: 'Arial', size: 20, color: C.slate,
        }),
      ],
    }),
    pageBreak(),
  );

  // -- Per-Framework Sections -----------------------------------------------
  frameworks.forEach((fw, fwIdx) => {
    children.push(
      h1(`Framework ${fwIdx + 1}: ${fw.name}`),
      rule(),
    );

    // Score line
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          new TextRun({ text: 'Compliance Score: ', font: 'Arial', size: 24, bold: true, color: C.navy }),
          new TextRun({ text: `${Math.round(fw.score)}%`, font: 'Arial', size: 24, bold: true, color: scoreColor(fw.score) }),
        ],
      }),
    );

    if (fw.summary) {
      children.push(body(fw.summary));
    }

    // Strengths
    if (fw.strengths.length > 0) {
      children.push(h2('Strengths'));
      fw.strengths.forEach((s) => children.push(bullet(s)));
      children.push(new Paragraph({ spacing: { after: 120 } }));
    }

    // Gaps
    children.push(h2('Compliance Gaps'));

    if (fw.gaps.length === 0) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'No gaps identified for this framework.', font: 'Arial', size: 22, bold: true, color: C.emerald })],
          spacing: { after: 200 },
        }),
      );
    } else {
      const gapRows: TableRow[] = [
        gapHeaderRow(GAP_COLS.map((col, i) => ({ label: col.label, width: GAP_COL_WIDTHS[i] }))),
        ...fw.gaps.map((gap: GapItem, gi: number) => {
          const bg = gap.priority % 2 === 0 ? C.offWhite : C.white;
          return new TableRow({
            children: [
              cell(String(gi + 1),                    GAP_COL_WIDTHS[0], { bg, centered: true }),
              cell(gap.title,                         GAP_COL_WIDTHS[1], { bg, bold: true, size: 18 }),
              cell(gap.severity,                      GAP_COL_WIDTHS[2], { bg: severityBg(gap.severity), bold: true, color: severityColor(gap.severity), centered: true }),
              cell(`${gap.regulatoryBasis}${(gap as Record<string, unknown>).citationVerified === true ? ' [\u2713 Verified]' : ' [\u26A0 Unverified]'}`, GAP_COL_WIDTHS[3], { bg }),
              cell(gap.policyCurrentState,            GAP_COL_WIDTHS[4], { bg }),
              cell(gap.recommendation,                GAP_COL_WIDTHS[5], { bg }),
              evidenceCell(gap.evidenceRequired ?? [], GAP_COL_WIDTHS[6]),
              cell(s(gap.responsibleRole) || '\u2014',     GAP_COL_WIDTHS[7], { bg }),
              cell(gap.effort,                        GAP_COL_WIDTHS[8], { bg, centered: true }),
              cell(String(gap.priority),              GAP_COL_WIDTHS[9], { bg, bold: true, centered: true }),
            ],
          });
        }),
      ];

      children.push(
        new Table({
          width: { size: CONTENT_W, type: WidthType.DXA },
          columnWidths: [...GAP_COL_WIDTHS],
          rows: gapRows,
        }) as unknown as Paragraph,
      );
    }

    children.push(pageBreak());
  });

  // -- Action Plan ----------------------------------------------------------
  children.push(h1('Remediation Action Plan'), rule());

  children.push(body(
    'The following actions are prioritised by urgency and regulatory impact. ' +
    'Dependencies between actions are noted to support implementation sequencing.',
  ));

  const sortedPlan = [...actionPlan].sort((a: ActionPlanItem, b: ActionPlanItem) => a.priority - b.priority);

  const actionRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        { label: 'Priority',      width: ACTION_COL_WIDTHS[0] },
        { label: 'Action',        width: ACTION_COL_WIDTHS[1] },
        { label: 'Responsible',   width: ACTION_COL_WIDTHS[2] },
        { label: 'Deadline',      width: ACTION_COL_WIDTHS[3] },
        { label: 'Dependencies',  width: ACTION_COL_WIDTHS[4] },
        { label: 'Effort',        width: ACTION_COL_WIDTHS[5] },
        { label: 'Resources',     width: ACTION_COL_WIDTHS[6] },
      ].map((col) =>
        new TableCell({
          borders: ALL_BORDERS,
          width: { size: col.width, type: WidthType.DXA },
          shading: { fill: C.navy, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({
            children: [new TextRun({ text: col.label, font: 'Arial', size: 18, bold: true, color: C.white })],
          })],
        })
      ),
    }),
    ...sortedPlan.map((item: ActionPlanItem, idx: number) => {
      const isHigh = item.priority <= 3;
      const bg = idx % 2 === 0 ? C.white : C.offWhite;
      const deps = item.dependsOn && item.dependsOn.length > 0
        ? item.dependsOn.join(', ')
        : 'None';
      return new TableRow({
        children: [
          cell(String(item.priority),              ACTION_COL_WIDTHS[0], { bg: isHigh ? 'FEF9C3' : bg, bold: isHigh, color: isHigh ? C.gold : C.slate, centered: true }),
          cell(item.action,                        ACTION_COL_WIDTHS[1], { bg, bold: true, size: 18 }),
          cell(s(item.responsibleRole) || '\u2014',     ACTION_COL_WIDTHS[2], { bg }),
          cell(item.deadline,                      ACTION_COL_WIDTHS[3], { bg }),
          cell(deps,                               ACTION_COL_WIDTHS[4], { bg }),
          cell(item.effort,                        ACTION_COL_WIDTHS[5], { bg, centered: true }),
          cell(item.resources.join(', '),          ACTION_COL_WIDTHS[6], { bg }),
        ],
      });
    }),
  ];

  children.push(
    new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [...ACTION_COL_WIDTHS],
      rows: actionRows,
    }) as unknown as Paragraph,
    pageBreak(),
  );

  // -- Appendix A: Regulatory References -----------------------------------
  children.push(h1('Appendix A: Regulatory References'), rule());

  let hasRefs = false;
  frameworks.forEach((fw) => {
    const refs = [...new Set(fw.gaps.map((g) => g.regulatoryBasis).filter(Boolean))];
    if (refs.length === 0) return;
    hasRefs = true;
    children.push(h2(fw.name));
    refs.forEach((ref, i) =>
      children.push(new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${ref}`, font: 'Arial', size: 20, color: C.slate })],
        spacing: { after: 80 },
      }))
    );
  });

  if (!hasRefs) {
    children.push(body('No specific regulatory references were cited in this analysis.'));
  }

  children.push(pageBreak());

  // -- Appendix B: Evidence Checklist --------------------------------------
  children.push(h1('Appendix B: Required Evidence & Documentation Checklist'), rule());
  children.push(body(
    'The following documents must be produced or obtained to close the identified compliance gaps. ' +
    'Print this checklist and check off items as they are completed.',
  ));

  let hasEvidence = false;
  frameworks.forEach((fw) => {
    const seen = new Set<string>();
    const items: Array<{ evidence: string; gapId: string }> = [];
    for (const gap of fw.gaps) {
      for (const ev of gap.evidenceRequired ?? []) {
        if (ev && !seen.has(ev)) {
          seen.add(ev);
          items.push({ evidence: ev, gapId: gap.id });
        }
      }
    }
    if (items.length === 0) return;
    hasEvidence = true;
    children.push(h2(fw.name));
    items.forEach((item) =>
      children.push(checkBullet(`${item.evidence}  [Gap: ${item.gapId}]`))
    );
    children.push(new Paragraph({ spacing: { after: 160 } }));
  });

  if (!hasEvidence) {
    children.push(body('No specific evidence requirements were identified in this analysis.'));
  }

  children.push(pageBreak());

  // -- Appendix C: Glossary -------------------------------------------------
  children.push(h1('Appendix C: Glossary of Regulatory Terms'), rule());

  const glossaryData: Array<[string, string, string]> = [
    ['DPA',      'Data Protection Act',                             "Kenya's primary data protection legislation (Act No. 24 of 2019)"],
    ['ODPC',     'Office of the Data Protection Commissioner',      'Regulator responsible for enforcing the DPA 2019'],
    ['CBK',      'Central Bank of Kenya',                           'Regulator for banks, microfinance institutions, and payment service providers'],
    ['CMA',      'Capital Markets Authority',                       'Regulator for securities and capital markets'],
    ['DPO',      'Data Protection Officer',                         "Individual responsible for an organisation's data protection compliance"],
    ['DSAR',     'Data Subject Access Request',                     'Formal request by an individual to access their personal data'],
    ['DPIA',     'Data Protection Impact Assessment',               'Assessment of risks posed by data processing activities'],
    ['AML/CFT',  'Anti-Money Laundering / Combating the Financing of Terrorism', 'Regulatory framework for preventing financial crimes'],
    ['KYC',      'Know Your Customer',                              'Customer identification and verification requirements'],
    ['CDD',      'Customer Due Diligence',                          'Ongoing monitoring and risk assessment of customers'],
    ['PEP',      'Politically Exposed Person',                      'Individual with prominent public function requiring enhanced due diligence'],
    ['STR',      'Suspicious Transaction Report',                   'Report filed with the Financial Reporting Centre for suspect transactions'],
    ['POCAMLA',  'Proceeds of Crime and Anti-Money Laundering Act', "Kenya's primary AML legislation"],
    ['NPS',      'National Payment System',                         "Kenya's payment system regulated under the NPS Act 2011"],
    ['DCPR',     'Digital Credit Providers Regulations',            '2022 regulations governing digital lending in Kenya'],
    ['PCI-DSS',  'Payment Card Industry Data Security Standard',    'International standard for cardholder data security'],
    ['ISO 27001','ISO/IEC 27001',                                   'International standard for information security management systems'],
  ];

  const glossaryColWidths = [1500, 3000, 4526] as const;
  const glossaryRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: ['Abbreviation', 'Full Name', 'Description'].map((label, i) =>
        new TableCell({
          borders: ALL_BORDERS,
          width: { size: glossaryColWidths[i], type: WidthType.DXA },
          shading: { fill: C.navy, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 100, right: 100 },
          children: [new Paragraph({
            children: [new TextRun({ text: label, font: 'Arial', size: 18, bold: true, color: C.white })],
          })],
        })
      ),
    }),
    ...glossaryData.map(([abbr, fullName, desc], gi) => {
      const bg = gi % 2 === 0 ? C.white : C.offWhite;
      return new TableRow({
        children: [
          cell(abbr,     glossaryColWidths[0], { bg, bold: true, color: C.navy }),
          cell(fullName, glossaryColWidths[1], { bg }),
          cell(desc,     glossaryColWidths[2], { bg }),
        ],
      });
    }),
  ];

  children.push(
    new Table({
      width: { size: CONTENT_W, type: WidthType.DXA },
      columnWidths: [...glossaryColWidths],
      rows: glossaryRows,
    }) as unknown as Paragraph,
  );

  // -- Headers & Footers -----------------------------------------------------
  const mainHeader = new Header({
    children: [
      new Paragraph({
        children: [
          new TextRun({ text: 'CONFIDENTIAL', font: 'Arial', size: 16, bold: true, color: C.gold }),
          new TextRun({ text: '\tSheriaBot Gap Analysis Report', font: 'Arial', size: 16, color: C.slate }),
        ],
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: C.navy, space: 1 } },
      }),
    ],
  });

  const mainFooter = new Footer({
    children: [
      new Paragraph({
        children: [
          new TextRun({
            text: 'DISCLAIMER: This report is AI-generated for informational purposes only and does not constitute legal advice.',
            font: 'Arial', size: 12, italics: true, color: C.gold,
          }),
        ],
        spacing: { after: 40 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: `${displayName} \u2014 Generated by SheriaBot`, font: 'Arial', size: 16, color: C.slate }),
          new TextRun({ text: '\tPage ', font: 'Arial', size: 16, color: C.slate }),
          new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: C.slate }),
        ],
        tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: 'CCCCCC', space: 1 } },
      }),
    ],
  });

  return {
    properties: {
      page: {
        size: { width: 11906, height: 16838 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    headers: { default: mainHeader },
    footers: { default: mainFooter },
    children,
  };
}

// --- Public API ---------------------------------------------------------------

class GapAnalysisExportService {
  /**
   * Generate a DOCX report buffer from a validated GapAnalysisResult.
   * The buffer can be uploaded directly to R2 or streamed to the client.
   */
  async generateGapAnalysisDocx(params: DocxExportParams): Promise<Buffer> {
    const doc = new Document({
      title: `Gap Analysis Report \u2014 ${params.documentName}`,
      description: 'Regulatory Compliance Gap Analysis generated by SheriaBot',
      styles: {
        default: {
          document: {
            run: { font: 'Arial', size: 22, color: C.slate },
          },
        },
        paragraphStyles: [
          {
            id: 'Heading1',
            name: 'Heading 1',
            basedOn: 'Normal',
            next: 'Normal',
            quickFormat: true,
            run: { size: 32, bold: true, font: 'Arial', color: C.navy },
            paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
          },
          {
            id: 'Heading2',
            name: 'Heading 2',
            basedOn: 'Normal',
            next: 'Normal',
            quickFormat: true,
            run: { size: 28, bold: true, font: 'Arial', color: C.emerald },
            paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 1 },
          },
          {
            id: 'Heading3',
            name: 'Heading 3',
            basedOn: 'Normal',
            next: 'Normal',
            quickFormat: true,
            run: { size: 24, bold: true, font: 'Arial', color: C.navy },
            paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 },
          },
        ],
      },
      numbering: {
        config: [
          {
            reference: 'bullets',
            levels: [{
              level: 0,
              format: LevelFormat.BULLET,
              text: '\u2022',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            }],
          },
          {
            reference: 'evidence-checklist',
            levels: [{
              level: 0,
              format: LevelFormat.BULLET,
              // Ballot box character for printable checklist items
              text: '\u2610',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } },
            }],
          },
        ],
      },
      sections: [
        buildCoverSection(params),
        buildMainSection(params),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as unknown as any,
    });

    return Packer.toBuffer(doc);
  }

  /**
   * Sanitise a string for use in a filename.
   * Replaces spaces and special characters, collapses repeated underscores.
   */
  sanitiseFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
  }
}

export const gapAnalysisExportService = new GapAnalysisExportService();
export { GapAnalysisExportService };

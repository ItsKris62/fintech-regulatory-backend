import { RawChunkGapItemSchema, type RawChunkGapItem } from '@/lib/ai/prompts/gap-analysis';

export const GOLDEN_POLICY_TEXT = `
# Governance
The board approves the compliance programme annually. Access reviews occur quarterly.

# Incident Management
Material incidents are escalated to the compliance officer, but no regulator-notification deadline is defined.

# Data Retention
Customer due-diligence records are retained for seven years.

# System Logging
All system logs are deleted after twelve months, including logs used for customer due-diligence investigations.

# Complaints
The policy contains no documented complaints escalation or response timetable.
`.trim();

export const GOLDEN_EVIDENCE = {
  governance: 'evidence-governance-1',
  incidentNotification: 'evidence-incident-1',
  retention: 'evidence-retention-1',
  complaints: 'evidence-complaints-1',
} as const;

function finding(overrides: Partial<RawChunkGapItem> & Pick<RawChunkGapItem, 'id' | 'title' | 'severity'>): RawChunkGapItem {
  return RawChunkGapItemSchema.parse({
    framework: 'AML_FRAMEWORK',
    requirement: overrides.title,
    status: 'GAP',
    severityRationale: 'Synthetic deterministic fixture risk.',
    regulatoryBasis: 'Synthetic Regulation section 1',
    description: overrides.title,
    policyCurrentState: 'Fixture policy state',
    recommendation: 'Remediate the fixture control.',
    effort: 'MEDIUM',
    priority: 1,
    evidenceIds: [GOLDEN_EVIDENCE.incidentNotification],
    policyEvidenceIds: ['pol-chunk-1'],
    evidenceRequired: [],
    responsibleRole: 'Compliance Officer',
    regulatoryDeadline: 'Not specified by fixture',
    ...overrides,
  });
}

export const GOLDEN_QUICK_FINDINGS: RawChunkGapItem[] = [
  finding({
    id: 'INCIDENT-NOTIFICATION',
    title: 'Regulatory incident notification deadline absent',
    severity: 'HIGH',
    evidenceIds: [GOLDEN_EVIDENCE.incidentNotification],
    policyEvidenceIds: ['pol-chunk-2'],
  }),
];

export const GOLDEN_STANDARD_FINDINGS: RawChunkGapItem[] = [
  ...GOLDEN_QUICK_FINDINGS,
  finding({
    id: 'COMPLAINTS-PROCEDURE',
    title: 'Complaints escalation and response procedure absent',
    severity: 'MEDIUM',
    evidenceIds: [GOLDEN_EVIDENCE.complaints],
    policyEvidenceIds: [],
  }),
];

export const GOLDEN_DEEP_ENHANCED_FINDINGS: RawChunkGapItem[] = [
  finding({
    id: 'RETENTION-CONTRADICTION',
    title: 'Investigation record retention statements conflict',
    severity: 'HIGH',
    evidenceIds: [GOLDEN_EVIDENCE.retention],
    policyEvidenceIds: ['pol-chunk-3', 'pol-chunk-4'],
  }),
];

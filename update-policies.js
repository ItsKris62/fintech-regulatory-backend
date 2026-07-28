const fs = require('fs');
const file = '../n8n_W-SHARED-ERR_error_handler.phase-f-reviewed.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const codeNode = data.nodes.find(n => n.name === 'Normalise, Redact and Classify');
if (!codeNode) {
    console.error("Node not found!");
    process.exit(1);
}
let code = codeNode.parameters.jsCode;

const newPolicies = `
  {
    match: /agents\\\\.automation\\\\.triageEditorialCandidate/i,
    operation: 'EDITORIAL_TRIAGE',
    sideEffectRisk: 'MEDIUM',
    timeoutState: 'UNKNOWN',
    retryPolicy: 'IDEMPOTENCY_REQUIRED',
    requiresHumanActionOverride: true
  },
  {
    match: /agents\\\\.automation\\\\.getEditorialTriage/i,
    operation: 'EDITORIAL_TRIAGE_READ',
    sideEffectRisk: 'LOW',
    timeoutState: 'FAILED',
    retryPolicy: 'SAFE',
    requiresHumanActionOverride: false
  },
  {
    match: /agents\\\\.automation\\\\.createResearchPack/i,
    operation: 'RESEARCH_PACK_CREATION',
    sideEffectRisk: 'MEDIUM',
    timeoutState: 'UNKNOWN',
    retryPolicy: 'IDEMPOTENCY_REQUIRED',
    requiresHumanActionOverride: true
  },
  {
    match: /agents\\\\.automation\\\\.getResearchPack/i,
    operation: 'RESEARCH_PACK_READ',
    sideEffectRisk: 'LOW',
    timeoutState: 'FAILED',
    retryPolicy: 'SAFE',
    requiresHumanActionOverride: false
  },
  {
    match: /agents\\\\.automation\\\\.verifyBlogPostClaims/i,
    operation: 'SEMANTIC_VERIFICATION',
    sideEffectRisk: 'MEDIUM',
    timeoutState: 'UNKNOWN',
    retryPolicy: 'IDEMPOTENCY_REQUIRED',
    requiresHumanActionOverride: true
  },
  {
    match: /agents\\\\.automation\\\\.getVerificationResult/i,
    operation: 'SEMANTIC_VERIFICATION_READ',
    sideEffectRisk: 'LOW',
    timeoutState: 'FAILED',
    retryPolicy: 'SAFE',
    requiresHumanActionOverride: false
  },
  {
    match: /agents\\\\.automation\\\\.listFreshnessReviewCandidates/i,
    operation: 'FRESHNESS_REVIEW_LIST',
    sideEffectRisk: 'LOW',
    timeoutState: 'FAILED',
    retryPolicy: 'SAFE',
    requiresHumanActionOverride: false
  },
  {
    match: /agents\\\\.automation\\\\.runFreshnessReview/i,
    operation: 'FRESHNESS_REVIEW_RUN',
    sideEffectRisk: 'MEDIUM',
    timeoutState: 'UNKNOWN',
    retryPolicy: 'IDEMPOTENCY_REQUIRED',
    requiresHumanActionOverride: true
  },
  {
    match: /agents\\\\.automation\\\\.createRevisionRequest/i,
    operation: 'REVISION_REQUEST_CREATION',
    sideEffectRisk: 'MEDIUM',
    timeoutState: 'UNKNOWN',
    retryPolicy: 'IDEMPOTENCY_REQUIRED',
    requiresHumanActionOverride: true
  }
`;

code = code.replace(/];/, ',\n' + newPolicies + '\n];');
codeNode.parameters.jsCode = code;

fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log('Appended policies.');

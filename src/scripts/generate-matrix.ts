import fs from 'fs';
import path from 'path';

const OUT_DIR = path.join(__dirname, '../../../uat-results');
const resultsPath = path.join(OUT_DIR, 'uat_results.json');

if (!fs.existsSync(resultsPath)) {
  console.error("No uat_results.json found.");
  process.exit(1);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));

let md = `# Phase 3 UAT Coverage Matrix\n\n`;
md += `| Test Name | Mode | Requested Jurisdictions | Result | Grounded | Citations Present | Gap Explicitly Documented | Grader/Verifier Failed |\n`;
md += `|---|---|---|---|---|---|---|---|\n`;

let allPassed = true;

for (const r of results) {
  if (!r.success) {
    md += `| ${r.name} | ERROR | - | FAIL | - | - | - | - |\n`;
    allPassed = false;
    continue;
  }

  const mode = r.mode || '-';
  const reqJ = r.jurisdictions ? r.jurisdictions.join(',') : '-';
  
  // Calculate citations
  const citJs = new Set(r.citations?.map((c: any) => c.jurisdictionCode) || []);
  const citJStr = Array.from(citJs).join(',') || 'None';
  
  // Check for gaps
  let missing = false;
  if (r.jurisdictions) {
    for (const j of r.jurisdictions) {
      if (!citJs.has(j)) missing = true;
    }
  }

  const gapDocumented = missing && r.response && r.response.toLowerCase().includes('no specific evidence was found');
  
  let result = 'PASS';
  if (r.abstained || !r.grounded) result = 'FAIL (Not Grounded/Abstained)';
  if (missing && !gapDocumented && r.name.includes('Compare')) result = 'FAIL (Missing Citation w/o Gap Explanation)';
  
  // Cross country wrong support check
  if (r.name.includes('Wrong Support')) {
    result = (!r.grounded || r.abstained) ? 'PASS' : 'FAIL (Should not be grounded)';
  }

  // A/B/C/D Controlled cases
  if (r.name.includes('Controlled Case A') || r.name.includes('Controlled Case B') || r.name.includes('Controlled Case C')) {
     result = (!r.grounded || r.abstained) ? 'FAIL (Should be PARTIAL/grounded)' : 'PASS';
  }
  if (r.name.includes('Controlled Case D')) {
     result = (!r.grounded || r.abstained) ? 'PASS' : 'FAIL (Should not be grounded)';
  }

  if (result.startsWith('FAIL')) allPassed = false;

  md += `| ${r.name} | ${mode} | ${reqJ} | ${result} | ${r.grounded} | ${citJStr} | ${missing ? (gapDocumented ? 'Yes' : 'No') : 'N/A'} | ${r.graderFailed || r.fallbackReason || 'No'} |\n`;
}

md += `\n## Overall Result: ${allPassed ? '✅ PASSED ALL HARD GATES' : '❌ FAILED HARD GATES'}\n`;

fs.writeFileSync(path.join(__dirname, '../../../../Sheria-Bot-SaaS/uat_coverage_matrix.md'), md);

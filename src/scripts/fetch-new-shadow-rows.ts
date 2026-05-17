import { prisma } from '@/lib/prisma/client';

const NEW_IDS = [
  'cmp8skxgi00015ws5h43sed7o', // S1 simple
  'cmp8slifj00035ws5t2bfyx1u', // S2 simple
  'cmp8smg1700055ws5fmt2hj3v', // C1 complex/downgrade
  'cmp8sn55300075ws5263oiduw', // C2 complex
  'cmp8so0ja00095ws5u61ls3uu', // C3 complex/downgrade
  'cmp8sook4000b5ws593ezvgtp', // W1 weak
  'cmp8spjxw000d5ws5u8lhtb0y', // W2 weak
  'cmp8sqfkt000f5ws5slrelqze', // A1 ambiguous
  'cmp8sr8b3000h5ws5wydv7f67', // A2 ambiguous
];
const LABELS = ['S1','S2','C1','C2','C3','W1','W2','A1','A2'];

async function main() {
  const rows = await prisma.complianceQueryRun.findMany({
    where: { id: { in: NEW_IDS } },
    orderBy: { createdAt: 'asc' },
  });

  for (const r of rows) {
    const label = LABELS[NEW_IDS.indexOf(r.id)] ?? '??';
    const accepted = Array.isArray(r.acceptedChunkIds) ? r.acceptedChunkIds.length : 0;
    console.log(`\n=== ${label} (${r.id}) ===`);
    console.log(`  shadow=${r.shadow}  status=${r.status}  wallMs=${r.wallMs}`);
    console.log(`  route=${r.route}  confidence=${r.routeConfidence}  downgraded=${r.routeDowngraded}  downgradeReason=${r.routeDowngradeReason ?? 'null'}`);
    console.log(`  subQuestions=${JSON.stringify(r.subQuestions)}`);
    console.log(`  grounded=${r.grounded}  ragSources=${r.ragSources}  gradeInspected=${r.gradeChunksInspected}  accepted=${accepted}  rejected=${r.rejectedChunkCount}`);
    console.log(`  tokenBudgetExceeded=${r.tokenBudgetExceeded}  inputTok=${r.inputTokens}  outputTok=${r.outputTokens}`);
    console.log(`  controlTokens=${JSON.stringify(r.controlTokens)}`);
    console.log(`  graderFailed=${r.graderFailed}  routerParseFallback=${r.routerParseFallback}  verifierParseFallback=${r.verifierParseFallback}`);
    console.log(`  verdict=${r.verifierVerdict}  unsupportedClaims=${JSON.stringify(r.unsupportedClaims)}`);
    console.log(`  fallbackReason=${r.fallbackReason ?? 'null'}  errorMessage=${r.errorMessage ?? 'null'}`);
  }

  console.log('\n=== SUMMARY ===');
  const routerFail = rows.filter(r => r.routerParseFallback).length;
  const graderFail = rows.filter(r => r.graderFailed).length;
  const verifierFail = rows.filter(r => r.verifierParseFallback).length;
  const downgraded = rows.filter(r => r.routeDowngraded).length;
  const fullPass = rows.filter(r => !r.graderFailed && !r.routerParseFallback && !r.verifierParseFallback).length;
  console.log(`  total=${rows.length}  cleanParse=${fullPass}  routerFail=${routerFail}  graderFail=${graderFail}  verifierFail=${verifierFail}  downgraded=${downgraded}`);

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });

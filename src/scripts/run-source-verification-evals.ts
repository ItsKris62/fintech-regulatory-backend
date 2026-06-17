import fs from 'fs';
import path from 'path';
import { RAGService } from '@/lib/rag/rag.service';
import {
  evaluateRetrievalResults,
  type RetrievalEvalResult,
  type SourceVerificationEvalItem,
} from '@/lib/source-grounding/evals';

type Options = {
  datasetPath: string;
  topK: number;
  minScore: number;
  writeJson?: string;
};

type Mode = 'v1' | 'v2' | 'prefer-v2';

type EvalReport = {
  datasetPath: string;
  itemCount: number;
  modes: Record<Mode, {
    expectedSourceHitRate: number;
    forbiddenSourceHitRate: number;
    abstainSatisfiedRate: number;
    averageMetadataCompleteness: number;
    results: RetrievalEvalResult[];
  }>;
};

function parseOptions(argv: string[]): Options {
  const datasetArg = argv.find((arg) => arg.startsWith('--dataset='));
  const topKArg = argv.find((arg) => arg.startsWith('--top-k='));
  const minScoreArg = argv.find((arg) => arg.startsWith('--min-score='));
  const writeArg = argv.find((arg) => arg.startsWith('--write-json='));
  return {
    datasetPath: datasetArg
      ? datasetArg.split('=')[1]
      : path.join(process.cwd(), 'src', 'evals', 'source-verification-golden.json'),
    topK: topKArg ? Number(topKArg.split('=')[1]) : 8,
    minScore: minScoreArg ? Number(minScoreArg.split('=')[1]) : 0.7,
    writeJson: writeArg?.split('=')[1],
  };
}

function loadDataset(datasetPath: string): SourceVerificationEvalItem[] {
  const absolutePath = path.isAbsolute(datasetPath) ? datasetPath : path.resolve(process.cwd(), datasetPath);
  const raw = fs.readFileSync(absolutePath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected eval dataset array at ${absolutePath}`);
  }
  return parsed as SourceVerificationEvalItem[];
}

function summarize(results: RetrievalEvalResult[]) {
  const count = results.length || 1;
  return {
    expectedSourceHitRate: Number((results.filter((result) => result.expectedSourceHit).length / count).toFixed(3)),
    forbiddenSourceHitRate: Number((results.filter((result) => result.forbiddenSourceHit).length / count).toFixed(3)),
    abstainSatisfiedRate: Number((results.filter((result) => result.abstainSatisfied).length / count).toFixed(3)),
    averageMetadataCompleteness: Number((results.reduce((sum, result) => sum + result.metadataCompleteness, 0) / count).toFixed(3)),
    results,
  };
}

export async function runSourceVerificationEvals(options: Options): Promise<EvalReport> {
  const dataset = loadDataset(options.datasetPath);
  const rag = new RAGService();
  const modes: Mode[] = ['v1', 'v2', 'prefer-v2'];
  const report: EvalReport = {
    datasetPath: options.datasetPath,
    itemCount: dataset.length,
    modes: {} as EvalReport['modes'],
  };

  for (const mode of modes) {
    const modeResults: RetrievalEvalResult[] = [];
    for (const item of dataset) {
      const results = await rag.search(item.question, {
        topK: options.topK,
        minScore: options.minScore,
        preferActiveSources: true,
        sourceIndexMode: mode,
        filter: item.jurisdiction ? { jurisdiction: item.jurisdiction } : undefined,
      });
      modeResults.push(evaluateRetrievalResults(item, results));
    }
    report.modes[mode] = summarize(modeResults);
  }

  if (options.writeJson) {
    fs.writeFileSync(options.writeJson, JSON.stringify(report, null, 2));
  }

  return report;
}

if (require.main === module) {
  runSourceVerificationEvals(parseOptions(process.argv.slice(2)))
    .then((report) => {
      console.log(JSON.stringify({
        datasetPath: report.datasetPath,
        itemCount: report.itemCount,
        modes: Object.fromEntries(Object.entries(report.modes).map(([mode, summary]) => [
          mode,
          {
            expectedSourceHitRate: summary.expectedSourceHitRate,
            forbiddenSourceHitRate: summary.forbiddenSourceHitRate,
            abstainSatisfiedRate: summary.abstainSatisfiedRate,
            averageMetadataCompleteness: summary.averageMetadataCompleteness,
          },
        ])),
      }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

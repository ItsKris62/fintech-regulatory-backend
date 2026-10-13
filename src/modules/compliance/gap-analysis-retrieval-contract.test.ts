import { describe, expect, it } from 'vitest';

import { getGapAnalysisDepthProfile } from '@/config/gap-analysis-depth-profiles';
import type { JurisdictionContext } from '@/types/jurisdiction';
import { buildGapAnalysisRetrievalRequest } from './gap-analysis-retrieval-contract';

const jurisdictionContext: JurisdictionContext = {
  mode: 'SINGLE',
  jurisdictions: ['KE'],
  primaryJurisdiction: 'KE',
  jurisdictionSource: 'REQUEST',
};

describe('buildGapAnalysisRetrievalRequest', () => {
  it('normalizes direct and async inputs to an identical retrieval contract', () => {
    const direct = buildGapAnalysisRetrievalRequest({
      question: 'DPA obligations',
      frameworkDisplay: 'Data Protection Act 2019',
      frameworkSlug: 'dpa-2019',
      jurisdictionContext,
      depthProfile: getGapAnalysisDepthProfile('quick'),
      namespace: 'batch63-development-uat',
    });
    const asyncWorker = buildGapAnalysisRetrievalRequest({
      question: 'DPA obligations',
      frameworkDisplay: 'Data Protection Act 2019',
      frameworkSlug: 'dpa-2019',
      jurisdictionContext: JSON.parse(JSON.stringify(jurisdictionContext)),
      depthProfile: getGapAnalysisDepthProfile('quick'),
      namespace: 'batch63-development-uat',
    });

    expect(asyncWorker).toEqual(direct);
    expect(asyncWorker.retrievalProfile).toMatchObject({
      namespace: 'batch63-development-uat',
      filter: { frameworkSlug: 'dpa-2019' },
      frameworkScope: 'DOMESTIC',
      topK: 4,
      minScore: 0.65,
    });
    expect(asyncWorker.jurisdictionContext).toMatchObject({
      primaryJurisdiction: 'KE',
      jurisdictions: ['KE'],
    });
  });

  it('preserves authorized benchmark document filters without weakening framework or jurisdiction scope', () => {
    const request = buildGapAnalysisRetrievalRequest({
      question: 'DPA obligations',
      frameworkDisplay: 'Data Protection Act 2019',
      frameworkSlug: 'dpa-2019',
      jurisdictionContext,
      depthProfile: getGapAnalysisDepthProfile('standard'),
      benchmarkDocumentIds: ['doc-1', 'doc-2'],
      namespace: 'uat-corpus',
    });

    expect(request.retrievalProfile?.filter).toEqual({
      frameworkSlug: 'dpa-2019',
      documentId: { $in: ['doc-1', 'doc-2'] },
    });
    expect(request.retrievalProfile?.frameworkScope).toBe('DOMESTIC');
  });
});

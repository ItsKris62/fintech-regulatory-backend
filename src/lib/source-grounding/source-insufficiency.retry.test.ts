import { describe, expect, it } from 'vitest';

import { SourceInsufficiencyError } from './source-insufficiency';

describe('SourceInsufficiencyError retry policy', () => {
  it('is terminal because retrying cannot create missing verified evidence', () => {
    const error = new SourceInsufficiencyError('Verified evidence is insufficient.');

    expect(error.retryable).toBe(false);
  });
});

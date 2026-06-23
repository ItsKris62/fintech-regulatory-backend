import { describe, it, expect } from 'vitest';
import { calculateBlogStaleness } from '../server/utils/blog-staleness';

describe('Blog Staleness Logic', () => {
  it('should return false for staleness when there is no verification run', () => {
    const post = {
      id: 'post-1',
      updatedAt: new Date(),
      sources: [],
      draftGenerationRuns: [],
      verificationRuns: []
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isStale).toBe(false);
    expect(result.isAiStale).toBe(false);
  });

  it('should be stale if post was updated after verification', () => {
    const verifiedAt = new Date('2024-01-01T00:00:00Z');
    const updatedAt = new Date('2024-01-02T00:00:00Z');
    
    const post = {
      id: 'post-1',
      updatedAt,
      sources: [],
      draftGenerationRuns: [],
      verificationRuns: [{ completedAt: verifiedAt }]
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isStale).toBe(true);
    expect(result.isAiStale).toBe(false);
  });

  it('should be stale if any source was updated after verification', () => {
    const verifiedAt = new Date('2024-01-01T00:00:00Z');
    
    const post = {
      id: 'post-1',
      updatedAt: new Date('2023-12-01T00:00:00Z'),
      sources: [
        { updatedAt: new Date('2023-12-15T00:00:00Z') }, // before
        { updatedAt: new Date('2024-01-02T00:00:00Z') }  // after
      ],
      draftGenerationRuns: [],
      verificationRuns: [{ completedAt: verifiedAt }]
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isStale).toBe(true);
    expect(result.isAiStale).toBe(false);
  });

  it('should not be stale if everything was updated before verification', () => {
    const verifiedAt = new Date('2024-01-05T00:00:00Z');
    
    const post = {
      id: 'post-1',
      updatedAt: new Date('2024-01-01T00:00:00Z'),
      sources: [
        { updatedAt: new Date('2024-01-01T00:00:00Z') }
      ],
      draftGenerationRuns: [
        { appliedToPost: true, appliedAt: new Date('2024-01-01T00:00:00Z') }
      ],
      verificationRuns: [{ completedAt: verifiedAt }]
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isStale).toBe(false);
    expect(result.isAiStale).toBe(false);
  });

  it('should be AI stale if an AI draft was applied after verification', () => {
    const verifiedAt = new Date('2024-01-01T00:00:00Z');
    const appliedAt = new Date('2024-01-02T00:00:00Z');
    
    const post = {
      id: 'post-1',
      updatedAt: new Date('2024-01-02T00:00:00Z'), // inherently true because appliedAt updates post
      sources: [],
      draftGenerationRuns: [
        { appliedToPost: true, appliedAt }
      ],
      verificationRuns: [{ completedAt: verifiedAt }]
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isStale).toBe(true);
    expect(result.isAiStale).toBe(true);
  });

  it('should not be AI stale if draft was not applied', () => {
    const verifiedAt = new Date('2024-01-01T00:00:00Z');
    
    const post = {
      id: 'post-1',
      updatedAt: new Date('2023-12-01T00:00:00Z'),
      sources: [],
      draftGenerationRuns: [
        { appliedToPost: false, appliedAt: null }
      ],
      verificationRuns: [{ completedAt: verifiedAt }]
    } as any;

    const result = calculateBlogStaleness(post);
    expect(result.isAiStale).toBe(false);
  });
});

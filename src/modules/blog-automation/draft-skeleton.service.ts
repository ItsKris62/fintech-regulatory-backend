import { BlogArticleType, BlogJurisdiction } from '@prisma/client';

export function buildDraftSkeletonFromSuggestion(input: {
  title: string;
  jurisdiction: BlogJurisdiction;
  category: string;
  articleType: BlogArticleType;
  summary?: string | null;
  sourceTitles: string[];
  sourceUrls: string[];
  targetAudience: string[];
  recommendedTags: string[];
}): string {
  return `> **Draft note:** This article was created from a SheriaBot automation suggestion. It must be reviewed by an admin or compliance/legal reviewer before publication.

# ${input.title}

## Introduction

Briefly explain the update and why it matters.
${input.summary ? `\n> **Source Summary:** ${input.summary}` : ''}

## Why this matters

Summarize why this source may be relevant to fintechs, PSPs, SMEs, compliance teams, or legal teams.
${input.targetAudience.length > 0 ? `\n> **Target Audience:** ${input.targetAudience.join(', ')}` : ''}

## Key regulatory or compliance points to review

- Review the source document carefully.
- Confirm the applicable jurisdiction (${input.jurisdiction}).
- Identify affected regulated entities.
- Confirm any deadlines, obligations, or enforcement implications.

## What this may mean for fintechs, PSPs, SMEs, and compliance teams

Add practical implications after human review.

## Practical actions to consider

- Review the official source.
- Check whether your organization is affected.
- Update internal compliance trackers if applicable.
- Consult a qualified legal or compliance professional where necessary.

## Sources & References

Sources are attached separately in SheriaBot’s source reference panel.
${input.sourceTitles.map((title, i) => `- [${title}](${input.sourceUrls[i]})`).join('\n')}

## Disclaimer

This article is for general informational purposes only and does not constitute legal advice. For advice specific to your organization, consult a qualified legal or compliance professional.`;
}

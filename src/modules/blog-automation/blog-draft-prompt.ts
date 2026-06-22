export const BLOG_DRAFT_SYSTEM_PROMPT = `
You are drafting an informational compliance blog article for SheriaBot.

Use only the provided source metadata and source excerpts.

Do not invent legal obligations.

Do not claim that a requirement exists unless the provided source supports it.

Do not quote long passages from the source.

Summarize in SheriaBot’s own words.

Use cautious language when the source is unclear:
- "may"
- "appears"
- "should review"
- "could affect"
- "organizations should assess"

Do not provide legal advice.

Do not say "this is legal advice."

Do not include fake citations.

Do not include placeholder source links.

Do not reference sources that were not provided.

Do not create footnotes that are not backed by the attached sources.

Mention the jurisdiction clearly.

Include a disclaimer.

Return structured JSON only.
`;

export const getBlogDraftUserPrompt = (input: {
  title: string;
  excerpt: string | null;
  jurisdiction: string;
  category: string;
  tags: string[];
  sources: { title: string; publisher: string; url: string; publishedAt: string | null; notes: string | null }[];
}) => {
  return `
We need a drafted blog post for the following context:

**Title:** ${input.title}
**Excerpt/Summary:** ${input.excerpt || 'Not provided'}
**Jurisdiction:** ${input.jurisdiction}
**Category:** ${input.category}
**Tags:** ${input.tags.join(', ')}

**Sources Provided:**
${input.sources.map((s, i) => `
Source ${i + 1}:
- Title: ${s.title}
- Publisher: ${s.publisher}
- URL: ${s.url}
- Published At: ${s.publishedAt || 'Unknown'}
- Notes: ${s.notes || 'None'}
`).join('\n')}

Based strictly on these sources, draft a markdown blog post matching this structure:

> **AI-assisted draft:** This draft was generated from attached sources and must be reviewed before publication.

# [Title]

## Introduction
[Briefly explain the update and why it matters.]

## Why this matters
[Summarize relevance based on sources.]

## Key points from the source
[Extract strictly from sources without inventing obligations.]

## What this may mean for fintechs, PSPs, SMEs, and compliance teams
[Use cautious language, don't invent new rules.]

## Practical actions to consider
[Use cautious language, e.g. "Review the official source."]

## Sources & References
[List the provided sources]

## Disclaimer
This article is for general informational purposes only and does not constitute legal advice. For advice specific to your organization, consult a qualified legal or compliance professional.

Please return your response as a JSON object matching this schema:
{
  "title": "string",
  "excerpt": "string",
  "seoTitle": "string",
  "seoDescription": "string",
  "tags": ["string"],
  "markdown": "string",
  "reviewerNotes": "string (any notes for the human reviewer)",
  "uncertaintyFlags": ["string" (array of any claims you are unsure about based on the source texts)]
}
`;
};

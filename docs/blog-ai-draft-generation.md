# Blog Automation: AI Draft Generation

## Overview

Sprint 3.5 introduced the "Gate A" (Source-Backed Draft Creation) and "Gate B" (AI-Assisted Draft Generation) phases of our blog automation pipeline. These features are designed to significantly accelerate content creation for SheriaBot's regulatory intelligence blog, while strictly maintaining a human-in-the-loop review process and preventing hallucinated legal obligations.

## Gate A: Draft Creation from Suggestions

When a `BlogArticleSuggestion` is reviewed by an administrator and marked as `APPROVED_FOR_DRAFT`, the system permits the creation of a draft `BlogPost`.

**Key Constraints:**
- The suggestion must have a status of `APPROVED_FOR_DRAFT`.
- The suggestion must have at least one attached source (`BlogPostSource`).
- No draft can be created if one already exists for the suggestion.

**Process:**
1. The administrator clicks "Create Draft" from the suggestions UI.
2. The `adminCreateDraftFromSuggestion` tRPC procedure is called.
3. A unique slug is generated for the new post.
4. A markdown skeleton is constructed via `buildDraftSkeletonFromSuggestion`, mapping metadata like category, jurisdiction, target audience, and tags into the initial text area.
5. The attached sources from the suggestion are copied into new `BlogPostSource` records linked to the new draft.
6. The suggestion status is updated to `DRAFT_CREATED`.
7. The user is redirected to the blog editor for the new post.

## Gate B: AI-Assisted Drafting

Once a `BlogPost` exists in `DRAFT` or `IN_REVIEW` status, an administrator can generate markdown content automatically using the attached sources.

**Key Constraints (Human-in-the-Loop):**
- AI generation is *strictly admin-triggered*. The system does not autonomously generate or publish posts.
- A `BlogPost` must be in the `DRAFT` or `IN_REVIEW` state.
- The post *must* have attached `BlogPostSource` records. The AI is strictly instructed to only use information present in these references.
- AI generation fails early if these conditions are unmet.

**Process:**
1. The administrator clicks "Generate Draft" under the "AI Assisted Drafting" panel in the blog editor.
2. The `adminGenerateAiDraft` tRPC procedure calls `generateAiDraftForBlogPost`.
3. A `BlogDraftGenerationRun` record is created with a `PENDING` status to track the execution attempt.
4. The post's title, excerpt, jurisdiction, category, tags, and all attached sources are formatted into a rigid prompt via `getBlogDraftUserPrompt`.
5. The `BLOG_DRAFT_SYSTEM_PROMPT` enforces cautious language (e.g., "may", "appears"), bans legal advice statements, and prohibits hallucinated rules or sources.
6. The prompt is sent to `claude-3-5-sonnet-20240620` (configured with `temperature: 0.2` for deterministic, grounded outputs).
7. The AI responds with structured JSON containing the title, excerpt, SEO metadata, tags, markdown content, and reviewer notes.
8. The draft `BlogPost` is updated with the generated content.
9. The `BlogDraftGenerationRun` record is marked `SUCCESS`, recording any reviewer notes and uncertainty flags.

## Error Handling & Tracking

- Every AI execution attempt (success or failure) is logged in the `BlogDraftGenerationRun` table.
- Failed AI generation will *not* overwrite existing draft content. The error is saved in `BlogDraftGenerationRun.errorMessage`.
- Costs and token usage are natively handled and tracked by the central `src/lib/ai/client.ts` integration.

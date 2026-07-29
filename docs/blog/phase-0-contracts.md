# SheriaBot Blog Phase 0 Contracts

Last updated: 2026-07-29

## Canonical Blog Domain

`BlogPost` is the canonical model for SheriaBot Blog content.

`blog.*` tRPC procedures are the only supported public Blog API:

- `blog.publicList`
- `blog.publicGetBySlug`
- `blog.getFeatured`
- `blog.publicSlugs`
- `blog.adminList`
- `blog.adminGetById`
- `blog.adminCreate`
- `blog.adminUpdate`
- `blog.adminSetStatus`
- `blog.adminDelete`

`LegalDocument` is not a supported Blog publishing model. It remains available for explicitly retained legacy content surfaces such as Knowledge Base articles and policy templates.

## Legacy Content Policy

The legacy `content.*` router no longer accepts new `LegalDocument` rows with `contentType = BLOG_POST`.

Existing legacy `LegalDocument` rows with `contentType = BLOG_POST` are retained for operator assessment and cleanup. They are admin-only cleanup records in the legacy router and cannot be published through `content.publish`.

Public `content.getBySlug` is scoped to `contentType = KNOWLEDGE_BASE_ARTICLE` by default. It must not be used as a generic public `LegalDocument` slug endpoint.

## Public Blog Visibility

The shared public Blog predicate is implemented in:

```text
src/modules/blog/public-blog-visibility.ts
```

A public `BlogPost` must satisfy all of:

```text
status = PUBLISHED
deletedAt IS NULL
archivedAt IS NULL
publishedAt IS NOT NULL
publishedAt <= now
```

Archived posts are not public under the current product policy. `blog.adminSetStatus({ status: "ARCHIVED" })` removes a post from public Blog surfaces.

The same predicate is used by:

- `blog.publicList`
- `blog.publicGetBySlug`
- `blog.getFeatured`
- `blog.publicSlugs`
- `agents.automation.getApprovedContentThisWeek`

Public listing order is deterministic:

```text
publishedAt DESC
id DESC
```

The frontend sitemap consumes `blog.publicSlugs`; therefore sitemap entries inherit the same public visibility rule and exclude draft, deleted, archived, null-published and future-dated posts.

## Public Input Bounds

Public Blog inputs are bounded and normalized in `src/server/schemas/blog.schema.ts`:

- `search`: trimmed, 1-200 characters when present.
- `category`: trimmed, 1-100 characters when present.
- `tag`: trimmed, 1-100 characters when present.
- `slug`: 1-200 characters.
- listing `page`: integer, minimum 1.
- listing `limit`: integer, 1-50.
- featured `limit`: integer, 1-10.

Empty filter strings are rejected after trimming at the API contract layer. Frontend callers should omit empty filters.

## Publication Roles

Canonical Blog administration remains behind `adminProcedure`.

Machine publication is allowed only through explicitly capability-gated automation:

```text
agents.automation.publishContent
```

That procedure requires an approved backend-owned `AutomationApproval` and validates the approved publication snapshot before setting `BlogPost.status = PUBLISHED`.

## Automation Publication Snapshot

Blog publication approvals created through `agents.automation.createApproval` with:

```text
department = CONTENT
kind = BLOG_POST_PUBLICATION
metadata.blogPostId = <BlogPost id>
```

are enriched server-side with:

```text
metadata.publicationSnapshot
```

The snapshot is computed from the live backend row, not trusted from n8n.

Snapshot version:

```text
blog-publication-snapshot-v1
```

Snapshot fields:

- `blogPostId`
- `contentHash`
- `sourceSetHash`
- `publicationPayloadHash`
- `draftGenerationRunId`
- `verificationRunId`
- `postUpdatedAt`
- `computedAt`

`contentHash` reuses `computeContentHash` from `src/modules/blog-automation/editorial-input-hash.ts`.

`sourceSetHash` reuses `computeFallbackSourceSetHash` from `src/modules/blog-automation/editorial-input-hash.ts`.

`publicationPayloadHash` is a SHA-256 hash of the canonical publication payload:

- title
- slug
- excerpt
- markdown content hash
- category
- jurisdiction
- tags
- related regulations
- source-set hash

## Publish-Time Comparison

Immediately before publication, `agents.automation.publishContent` recomputes the current snapshot and compares it with the approved snapshot.

Publication fails safely when:

- approval is not approved;
- approval is expired;
- approval metadata is missing `blogPostId`;
- approval metadata is missing `publicationSnapshot`;
- snapshot `blogPostId` differs from metadata `blogPostId`;
- post is missing, deleted or archived;
- markdown content changed;
- source set changed;
- latest draft-generation run changed;
- latest verification run changed;
- title, slug, excerpt, category, jurisdiction, tags or related regulations changed;
- existing publish-readiness gates fail.

Machine-readable error markers used in tRPC error messages include:

- `APPROVAL_EXPIRED`
- `APPROVAL_POST_MISMATCH`
- `APPROVAL_SNAPSHOT_REQUIRED`
- `APPROVED_CONTENT_CHANGED`
- `APPROVED_SOURCES_CHANGED`
- `APPROVED_DRAFT_CHANGED`
- `APPROVED_PUBLICATION_PAYLOAD_CHANGED`
- `VERIFICATION_REQUIRED`
- `POST_ARCHIVED`

Retrying the same successful publish request is safe only while the live post still matches the approved snapshot. Replaying the approval after a later material edit is rejected.

Newsletter eligibility depends on actual persisted `BlogPost.status = PUBLISHED` state and the same public visibility predicate.

## Existing Data Assessment

Use the read-only script:

```bash
npx tsx src/scripts/audit-blog-phase0-data.ts
```

The script reports counts only. It does not print article bodies, email addresses, environment variable values or secrets.

Cleanup of legacy `LegalDocument` `BLOG_POST` records, approvals missing snapshot metadata or future-dated published `BlogPost` records requires a separate operator-reviewed remediation plan.

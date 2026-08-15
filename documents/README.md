# SheriaBot - Regulatory Document Corpus

This folder contains source documents and manifest metadata for the RAG knowledge
base.

## Folder Structure

```text
documents/
├── international/   - International standards and regional frameworks
├── kenya/           - Kenyan legislation, CBK guidelines, ODPC guidance, etc.
├── malawi/          - Malawi country corpus, grouped by category
├── nigeria/         - Nigeria country corpus, grouped by category
├── rwanda/          - Rwanda country corpus, grouped by category
├── _incoming/       - Candidate and manual intake review files
└── README.md
```

Country corpora may be flat, as with the original Kenya corpus, or nested by
category, as with Malawi, Nigeria, and Rwanda.

## Git Tracking

PDF, DOC, DOCX, and TXT files in this folder are gitignored because the source
binaries are large and are stored outside Git after ingestion. The tracked files
are:

- `README.md`
- `manifest.json`
- `.gitkeep` placeholders for empty country/category folders
- review and intake files under `_incoming/`

For Rwanda, the tracked skeleton is:

```text
documents/rwanda/
├── aml-cft/.gitkeep
├── banking/.gitkeep
├── consumer-protection/.gitkeep
├── cybersecurity/.gitkeep
├── data-protection/.gitkeep
├── guidance/.gitkeep
├── microfinance/.gitkeep
├── payments/.gitkeep
└── manifest.json
```

## How to Add Documents

1. Obtain the official document in PDF, DOCX, DOC, or TXT format.
2. Place it in the correct folder, for example
   `documents/rwanda/aml-cft/example-law.pdf`.
3. Add or update the corresponding entry in that country's `manifest.json`.
4. Run validation:

```bash
pnpm corpus:validate --country=rwanda --verify-checksums
```

5. Run ingestion when the manifest is ready:

```bash
pnpm ingest
```

The ingestion pipeline computes a SHA-256 checksum, skips already-indexed
copies, uploads the original file to Cloudflare R2, extracts and chunks text,
generates embeddings, and stores records for retrieval.

## Filename Conventions

- Use descriptive names that make the source recognizable.
- Prefer lowercase letters, numbers, and hyphens for new files.
- Keep category placement consistent with the manifest `category`.
- Use forward slashes in `localPath` values inside manifest files.

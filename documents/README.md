# SheriaBot — Regulatory Document Corpus

This folder contains source documents for the RAG knowledge base.

## Folder Structure

```
documents/
├── kenya/           — Kenyan legislation, CBK guidelines, ODPC guidance, etc.
├── international/   — International standards (NIST, ISO, PCI DSS, GDPR)
└── README.md        — This file
```

> **Note:** PDF, DOCX, and TXT files in this folder are gitignored (large
> binaries). Only this README and `.gitkeep` placeholders are tracked.

---

## How to Add Documents

1. Obtain the official document in PDF, DOCX, or TXT format.
2. Place it in the correct subfolder (`kenya/` or `international/`).
3. Confirm the `fileName` in the registry in
   [`src/scripts/ingest-documents.ts`](../src/scripts/ingest-documents.ts)
   matches the file you placed.
4. Run the ingestion pipeline:

```bash
pnpm ingest
```

The pipeline will:
- Compute a SHA-256 checksum and skip already-indexed copies
- Upload the original file to Cloudflare R2
- Extract and chunk the text (legal-aware chunking)
- Generate embeddings and upsert vectors to Pinecone
- Save chunk records to PostgreSQL

---

## Document Registry Checklist

Place each file in the indicated folder, then run `pnpm ingest`.

### Kenyan Legislation & Regulations

- [ ] `kenya/data-protection-act-2019.pdf`
      — Kenya Data Protection Act, 2019 — Parliament of Kenya
- [ ] `kenya/computer-misuse-cybercrimes-act-2018.pdf`
      — Computer Misuse and Cybercrimes Act, 2018 — Parliament of Kenya
- [ ] `kenya/cbk-prudential-guidelines-digital-lending.pdf`
      — CBK Prudential Guidelines for Digital Lending — Central Bank of Kenya
- [ ] `kenya/national-payment-systems-act.pdf`
      — National Payment Systems Act & Regulations — Parliament of Kenya
- [ ] `kenya/cbk-regulatory-sandbox-guidelines.pdf`
      — CBK Regulatory Sandbox Guidelines — Central Bank of Kenya
- [ ] `kenya/odpc-guidance-notes.pdf`
      — ODPC Guidance Notes and Compliance Guidelines — ODPC
- [ ] `kenya/aml-cft-guidelines.pdf`
      — AML/CFT Guidelines — Financial Reporting Centre
- [ ] `kenya/kenya-information-communications-act.pdf`
      — Kenya Information and Communications Act — Parliament of Kenya
- [ ] `kenya/central-bank-of-kenya-act.pdf`
      — Central Bank of Kenya Act (Fintech Sections) — Parliament of Kenya
- [ ] `kenya/cma-regulatory-sandbox-guidelines.pdf`
      — CMA Regulatory Sandbox Guidelines — Capital Markets Authority
- [ ] `kenya/ira-insurtech-guidelines.pdf`
      — IRA Insurtech Guidelines — Insurance Regulatory Authority

### International Standards

- [ ] `international/nist-csf-2.0.pdf`
      — NIST Cybersecurity Framework 2.0 — NIST
- [ ] `international/iso-27001-overview.pdf`
      — ISO 27001 Information Security Overview — ISO
- [ ] `international/pci-dss-requirements.pdf`
      — PCI DSS Requirements — PCI Security Standards Council
- [ ] `international/gdpr-full-text.pdf`
      — GDPR Full Text — European Union

---

## Filename Conventions

- Use lowercase letters, numbers, and hyphens only
- Include the year for legislation: `data-protection-act-2019.pdf`
- For versioned standards: `nist-csf-2.0.pdf`, `pci-dss-v4.0.pdf`
- Keep names short but unambiguous

---

## Re-ingesting a Document

If you need to update a document (e.g. an amended version):

```bash
# 1. Find the document ID in the DB
# 2. Run the re-ingest utility
npx tsx -e "
import { documentIngestionService } from './src/lib/ingestion/document-processor';
documentIngestionService
  .reingestDocument('DOCUMENT_ID', './documents/kenya/updated-file.pdf')
  .then(r => console.log(r))
  .finally(() => process.exit(0));
"
```

Or mark it as superseded and ingest the new file fresh by running `pnpm ingest`
(the old entry will be skipped by checksum; rename the new file slightly or
delete the old DB record first).

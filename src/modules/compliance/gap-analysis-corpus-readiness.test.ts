import { describe, expect, it } from "vitest";
import { CORPUS_VERSION_FALLBACK } from "@/lib/rag/corpus-version";
import { evaluateGapAnalysisCorpusReadiness } from "./gap-analysis-corpus-readiness";

describe("Gap Analysis corpus readiness evaluation", () => {
  const version = "7:source-fingerprint";

  it("fails closed when an approval is absent", () => {
    expect(
      evaluateGapAnalysisCorpusReadiness("KE", "dpa-2019", version).state,
    ).toBe("UNVERIFIED");
  });

  it("fails closed when the corpus version is unresolved or stale", () => {
    expect(
      evaluateGapAnalysisCorpusReadiness(
        "RW",
        "rw-dpa-2021",
        CORPUS_VERSION_FALLBACK,
      ).state,
    ).toBe("UNVERIFIED");
    expect(
      evaluateGapAnalysisCorpusReadiness("RW", "rw-dpa-2021", version, {
        status: "READY",
        corpusVersion: "6:old",
        sourceCount: 2,
        reviewedAt: new Date(),
      }).state,
    ).toBe("STALE");
  });

  it("requires a reviewed READY attestation with at least one source", () => {
    expect(
      evaluateGapAnalysisCorpusReadiness("NG", "ndpa-2023", version, {
        status: "READY",
        corpusVersion: version,
        sourceCount: 0,
        reviewedAt: new Date(),
      }).state,
    ).toBe("NOT_READY");
    expect(
      evaluateGapAnalysisCorpusReadiness("NG", "ndpa-2023", version, {
        status: "READY",
        corpusVersion: version,
        sourceCount: 2,
        reviewedAt: new Date(),
      }).state,
    ).toBe("READY");
  });
});

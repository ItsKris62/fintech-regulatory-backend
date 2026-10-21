import { describe, expect, it } from "vitest";
import {
  evaluateRequirementInventoryReadiness,
  determineApplicability,
  isApprovedCurrentRequirement,
} from "./regulatory-requirement-inventory";

const current = {
  stableKey: "KE:dpa:art-1",
  jurisdictionCode: "KE",
  frameworkSlug: "dpa-2019",
  approvalStatus: "APPROVED" as const,
  sourceDocumentId: "doc",
  provisionReference: "s.1",
  reviewedAt: new Date(),
  reviewedBy: "reviewer",
};
describe("reviewed requirement inventory contract", () => {
  it("accepts only reviewed approved current obligations in matching scope", () => {
    expect(isApprovedCurrentRequirement(current, "KE", "dpa-2019")).toBe(true);
    expect(
      isApprovedCurrentRequirement(
        { ...current, approvalStatus: "CANDIDATE" },
        "KE",
        "dpa-2019",
      ),
    ).toBe(false);
    expect(
      isApprovedCurrentRequirement(
        { ...current, supersededById: "new" },
        "KE",
        "dpa-2019",
      ),
    ).toBe(false);
    expect(isApprovedCurrentRequirement(current, "RW", "dpa-2019")).toBe(false);
  });

  it("requires a reviewed complete inventory bound to the active corpus manifest", () => {
    const inventory = {
      id: "inventory-1",
      jurisdictionCode: "KE",
      frameworkSlug: "dpa-2019",
      version: "2026-10-21",
      completeness: "COMPLETE",
      reviewedAt: new Date("2026-10-21T00:00:00.000Z"),
      reviewedBy: "reviewer-1",
      sourceManifestChecksum: "manifest-1",
      requirements: [{
        stableKey: "ke-dpa-1",
        approvalStatus: "APPROVED" as const,
        sourceDocumentId: "document-1",
        sourceVersionId: "version-1",
        provisionReference: "Section 25",
        reviewedAt: new Date("2026-10-21T00:00:00.000Z"),
        reviewedBy: "reviewer-1",
        supersededById: null,
      }],
    };

    expect(evaluateRequirementInventoryReadiness("KE", "dpa-2019", "manifest-1", inventory).state).toBe("READY");
    expect(evaluateRequirementInventoryReadiness("KE", "dpa-2019", "different-manifest", inventory).state).toBe("NOT_READY");
    expect(evaluateRequirementInventoryReadiness("KE", "dpa-2019", "manifest-1", {
      ...inventory,
      completeness: "PARTIAL",
    }).state).toBe("NOT_READY");
    expect(evaluateRequirementInventoryReadiness("KE", "dpa-2019", "manifest-1").state).toBe("UNVERIFIED");
  });
  it("does not infer applicability or exclusion without organization evidence", () => {
    expect(determineApplicability({ hasRequiredOrganizationData: false })).toBe(
      "UNDETERMINED",
    );
    expect(
      determineApplicability({
        hasRequiredOrganizationData: true,
        explicitlyExcluded: true,
      }),
    ).not.toBe("NOT_APPLICABLE");
    expect(
      determineApplicability({
        hasRequiredOrganizationData: true,
        explicitlyExcluded: true,
        documentedBasis: "Not a licensed PSP",
      }),
    ).toBe("NOT_APPLICABLE");
  });
});

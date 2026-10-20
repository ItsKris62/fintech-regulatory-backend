import { describe, expect, it } from "vitest";
import {
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

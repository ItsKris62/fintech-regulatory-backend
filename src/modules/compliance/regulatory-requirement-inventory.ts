export type InventoryCompleteness = "UNKNOWN" | "PARTIAL" | "COMPLETE";
export type RequirementApprovalStatus =
  | "CANDIDATE"
  | "REVIEWED"
  | "APPROVED"
  | "SUPERSEDED"
  | "REJECTED"
  | "APPLICABILITY_UNRESOLVED";
export type RequirementApplicability =
  "APPLICABLE" | "NOT_APPLICABLE" | "CONDITIONAL" | "UNDETERMINED";

export interface RequirementInventoryItem {
  stableKey: string;
  jurisdictionCode: string;
  frameworkSlug: string;
  approvalStatus: RequirementApprovalStatus;
  sourceDocumentId: string;
  sourceVersionId?: string | null;
  provisionReference: string;
  reviewedAt?: Date | null;
  reviewedBy?: string | null;
  supersededById?: string | null;
}

/** Only human-reviewed current obligations may define an assessment denominator. */
export function isApprovedCurrentRequirement(
  item: RequirementInventoryItem,
  jurisdictionCode: string,
  frameworkSlug: string,
): boolean {
  return (
    item.approvalStatus === "APPROVED" &&
    !item.supersededById &&
    Boolean(item.reviewedAt) &&
    Boolean(item.reviewedBy) &&
    item.jurisdictionCode === jurisdictionCode &&
    item.frameworkSlug.toLowerCase() === frameworkSlug.toLowerCase() &&
    Boolean(item.sourceDocumentId) &&
    Boolean(item.provisionReference)
  );
}

export function determineApplicability(input: {
  documentedBasis?: string;
  hasRequiredOrganizationData: boolean;
  explicitlyExcluded?: boolean;
}): RequirementApplicability {
  if (input.explicitlyExcluded && input.documentedBasis?.trim())
    return "NOT_APPLICABLE";
  if (!input.hasRequiredOrganizationData) return "UNDETERMINED";
  return input.documentedBasis?.trim() ? "APPLICABLE" : "CONDITIONAL";
}

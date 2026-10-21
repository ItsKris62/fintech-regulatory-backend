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

export type RequirementInventoryReadinessState = "READY" | "UNVERIFIED" | "NOT_READY";

export interface RequirementInventoryReadiness {
  jurisdictionCode: string;
  frameworkSlug: string;
  state: RequirementInventoryReadinessState;
  inventoryId: string | null;
  inventoryVersion: string | null;
  completeness: InventoryCompleteness;
  approvedRequirementCount: number;
  reviewedAt: Date | null;
  reason: string;
}

type RequirementInventoryRow = {
  id: string;
  jurisdictionCode: string;
  frameworkSlug: string;
  version: string;
  completeness: string;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  sourceManifestChecksum: string | null;
  requirements: Array<Omit<RequirementInventoryItem, "jurisdictionCode" | "frameworkSlug">>;
};

type RequirementInventoryClient = {
  regulatoryRequirementInventory: {
    findMany(args: unknown): Promise<RequirementInventoryRow[]>;
  };
};

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

export function evaluateRequirementInventoryReadiness(
  jurisdictionCode: string,
  frameworkSlug: string,
  expectedManifestChecksum: string | null,
  inventory?: RequirementInventoryRow | null,
): RequirementInventoryReadiness {
  const base = {
    jurisdictionCode,
    frameworkSlug,
    inventoryId: inventory?.id ?? null,
    inventoryVersion: inventory?.version ?? null,
    completeness: (inventory?.completeness ?? "UNKNOWN") as InventoryCompleteness,
    reviewedAt: inventory?.reviewedAt ?? null,
  };
  if (!inventory) {
    return {
      ...base,
      state: "UNVERIFIED",
      approvedRequirementCount: 0,
      reason: "No reviewed requirement inventory exists.",
    };
  }

  const approvedRequirementCount = inventory.requirements.filter((item) =>
    isApprovedCurrentRequirement(
      { ...item, jurisdictionCode: inventory.jurisdictionCode, frameworkSlug: inventory.frameworkSlug },
      jurisdictionCode,
      frameworkSlug,
    ),
  ).length;
  if (
    inventory.completeness !== "COMPLETE" ||
    !inventory.reviewedAt ||
    !inventory.reviewedBy ||
    approvedRequirementCount < 1
  ) {
    return {
      ...base,
      state: "NOT_READY",
      approvedRequirementCount,
      reason: "The requirement inventory is not a reviewed COMPLETE inventory with approved current requirements.",
    };
  }

  if (
    !expectedManifestChecksum ||
    !inventory.sourceManifestChecksum ||
    inventory.sourceManifestChecksum !== expectedManifestChecksum
  ) {
    return {
      ...base,
      state: "NOT_READY",
      approvedRequirementCount,
      reason: "The reviewed requirement inventory does not match the active reviewed corpus manifest.",
    };
  }

  return {
    ...base,
    state: "READY",
    approvedRequirementCount,
    reason: "Reviewed COMPLETE requirement inventory matches the active reviewed corpus manifest.",
  };
}

export async function getGapAnalysisRequirementInventoryReadiness(
  jurisdictionCode: string,
  frameworkSlugs: readonly string[],
  corpusManifestChecksums: ReadonlyMap<string, string | null>,
  db: RequirementInventoryClient,
): Promise<RequirementInventoryReadiness[]> {
  const normalizedSlugs = [...new Set(frameworkSlugs.map((slug) => slug.trim().toLowerCase()))];
  const inventories = normalizedSlugs.length === 0 ? [] : await db.regulatoryRequirementInventory.findMany({
    where: { jurisdictionCode, frameworkSlug: { in: normalizedSlugs } },
    orderBy: { reviewedAt: "desc" },
    select: {
      id: true,
      jurisdictionCode: true,
      frameworkSlug: true,
      version: true,
      completeness: true,
      reviewedAt: true,
      reviewedBy: true,
      sourceManifestChecksum: true,
      requirements: {
        where: { approvalStatus: "APPROVED", supersededById: null },
        select: {
          stableKey: true,
          approvalStatus: true,
          sourceDocumentId: true,
          sourceVersionId: true,
          provisionReference: true,
          reviewedAt: true,
          reviewedBy: true,
          supersededById: true,
        },
      },
    },
  });
  const latestByFramework = new Map<string, RequirementInventoryRow>();
  for (const inventory of inventories) {
    const normalized = inventory.frameworkSlug.toLowerCase();
    if (!latestByFramework.has(normalized)) latestByFramework.set(normalized, inventory);
  }
  return normalizedSlugs.map((frameworkSlug) => {
    const inventory = latestByFramework.get(frameworkSlug);
    return evaluateRequirementInventoryReadiness(
      jurisdictionCode,
      frameworkSlug,
      corpusManifestChecksums.get(frameworkSlug) ?? null,
      inventory,
    );
  });
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

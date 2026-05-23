/**
 * Curated Suggested Queries Configuration
 *
 * Industry -> curated suggestion templates map for the personalised suggested
 * queries feature. Each industry key maps to >=5 template strings.
 *
 * When `Organization.industry` is null or unmatched, `DEFAULT_SUGGESTIONS`
 * is used as the deterministic fallback for Signal #5 (curated baseline).
 *
 * These templates are also used by the cohort signal (Signal #4): popular
 * query topics from the same organizationType are matched against template
 * keywords to rank which template to surface.
 */

// -- Industry-specific suggestion templates ---------------------------------

const DIGITAL_LENDING_TEMPLATES = [
    "What are the latest KYC requirements for digital lenders in Kenya?",
    "How does the CBK Digital Credit Providers Regulations 2022 affect my lending business?",
    "What data protection obligations apply to digital lending platforms?",
    "What are the AML/CFT reporting requirements for digital lenders?",
    "How should digital lenders handle consumer complaints under Kenyan law?",
    "What interest rate caps apply to digital credit in Kenya?",
    "What are the licensing requirements for new digital lending products?",
] as const;

const MOBILE_MONEY_TEMPLATES = [
    "What are the KYC requirements for mobile money agents in Kenya?",
    "How do CBK Mobile Money Regulations affect e-money issuers?",
    "What consumer protection rules apply to mobile money services?",
    "What are the reporting obligations for mobile money transactions?",
    "How does the National Payment System Act apply to mobile money platforms?",
    "What interoperability requirements exist for mobile money services in Kenya?",
    "What are the AML requirements for mobile money transactions above KES 1 million?",
] as const;

const PAYMENT_SERVICES_TEMPLATES = [
    "What are the CBK licensing requirements for payment service providers?",
    "How do I comply with the National Payment System Act as a PSP?",
    "What are the data protection requirements for payment processing?",
    "What reporting obligations do payment service providers have to CBK?",
    "What are the AML/CFT obligations for payment gateways in Kenya?",
    "How do PSP regulations apply to cross-border payment services?",
    "What consumer protection rules apply to payment service providers?",
] as const;

const CRYPTO_TEMPLATES = [
    "What is the regulatory status of cryptocurrency exchanges in Kenya?",
    "What KYC/AML obligations apply to crypto trading platforms?",
    "How does the Capital Markets Authority regulate digital assets?",
    "What tax obligations apply to cryptocurrency transactions in Kenya?",
    "What are the reporting requirements for virtual asset service providers?",
    "How does Kenya's Data Protection Act apply to blockchain-based services?",
    "What sandbox licensing options exist for crypto fintechs in Kenya?",
] as const;

const MICROFINANCE_TEMPLATES = [
    "What are the SACCO regulatory requirements under SASRA in Kenya?",
    "How does the Microfinance Act affect community lending groups?",
    "What KYC requirements apply to microfinance institutions in Kenya?",
    "What reporting obligations do microfinance institutions have?",
    "How does the Data Protection Act apply to microfinance customer data?",
    "What consumer protection rules apply to microfinance lending?",
    "What are the capital adequacy requirements for microfinance banks?",
] as const;

const INSURANCE_TEMPLATES = [
    "What are the Insurance Regulatory Authority licensing requirements?",
    "How does the Insurance Act regulate insurtech platforms in Kenya?",
    "What data protection obligations apply to insurance companies?",
    "What AML/CFT requirements apply to insurance products?",
    "How should insurance companies handle claims under Kenyan consumer law?",
    "What solvency requirements apply to insurance companies in Kenya?",
    "What are the IRA reporting requirements for insurance intermediaries?",
] as const;

const BANKING_TEMPLATES = [
    "What are the CBK prudential guidelines for commercial banks in Kenya?",
    "How do the Banking Act capital adequacy requirements affect operations?",
    "What KYC/CDD obligations apply to corporate banking customers?",
    "What are the reporting requirements for banks under the CBK Act?",
    "How does the Proceeds of Crime and Anti-Money Laundering Act affect banks?",
    "What governance requirements apply to bank boards under CBK guidelines?",
    "What are the liquidity ratio requirements for banks in Kenya?",
] as const;

const TELECOM_TEMPLATES = [
    "How does the Kenya Information and Communications Act apply to fintech?",
    "What are the CAK licensing requirements for telecom-based financial services?",
    "What data protection obligations apply to telecom companies?",
    "How do mobile money regulations intersect with telecom licensing?",
    "What are the cybersecurity requirements for telecommunications operators?",
    "What consumer protection rules apply to telecom value-added services?",
    "What reporting obligations do telecom operators have for mobile financial services?",
] as const;

// -- Industry-keyword -> templates mapping ------------------------------------
// Keys are matched case-insensitively against Organization.industry substrings.
// Order matters: first match wins. Keep more-specific keys first.

const INDUSTRY_TEMPLATE_MAP: Array<{ keywords: string[]; templates: readonly string[] }> = [
    { keywords: ["crypto", "blockchain", "virtual asset", "digital asset", "web3"], templates: CRYPTO_TEMPLATES },
    { keywords: ["digital lending", "digital credit", "lending", "fintech lending"], templates: DIGITAL_LENDING_TEMPLATES },
    { keywords: ["mobile money", "mobile banking", "e-money", "e money", "emoney", "m-pesa", "mpesa", "mobile wallet"], templates: MOBILE_MONEY_TEMPLATES },
    { keywords: ["payment", "gateway", "psp", "payment service", "payment provider", "remittance"], templates: PAYMENT_SERVICES_TEMPLATES },
    { keywords: ["microfinance", "sacco", "microcredit", "community lending", "micro finance"], templates: MICROFINANCE_TEMPLATES },
    { keywords: ["insurance", "insurtech", "assurance", "underwriting"], templates: INSURANCE_TEMPLATES },
    { keywords: ["bank", "banking", "commercial bank", "deposit-taking"], templates: BANKING_TEMPLATES },
    { keywords: ["telecom", "telecommunications", "telco", "mobile network", "communications authority"], templates: TELECOM_TEMPLATES },
];

// -- Default / fallback templates ---------------------------------------------

export const DEFAULT_SUGGESTIONS: readonly string[] = [
    "What are the KYC requirements for digital lenders in Kenya?",
    "How do I comply with the Data Protection Act for mobile money services?",
    "What are the CBK reporting requirements for payment service providers?",
    "What consumer protection obligations apply to fintech companies in Kenya?",
    "What are the AML compliance requirements for financial technology businesses?",
    "How do I register a fintech product with the CBK sandbox?",
    "What cybersecurity requirements apply to fintech platforms in Kenya?",
] as const;

// -- Public API ---------------------------------------------------------------

/**
 * Resolve the curated suggestion templates for a given industry string.
 * Returns the matching industry template array, or the default suggestions
 * if no keyword match is found.
 */
export function resolveTemplatesForIndustry(industry: string | null | undefined): readonly string[] {
    if (!industry || industry.trim().length === 0) {
        return DEFAULT_SUGGESTIONS;
    }

    const search = industry.toLowerCase().trim();
    for (const entry of INDUSTRY_TEMPLATE_MAP) {
        for (const keyword of entry.keywords) {
            if (search.includes(keyword)) {
                return entry.templates;
            }
        }
    }

    return DEFAULT_SUGGESTIONS;
}

/**
 * All curated templates (from every industry category) flattened into a single
 * array, used by the cohort signal to map popular topics back to templates.
 * Each entry carries its source category for ranking tie-breaking.
 */
export interface CuratedTemplateEntry {
    template: string;
    industryKey: string; // the first keyword for the category
}

export function getAllCuratedTemplates(): CuratedTemplateEntry[] {
    const entries: CuratedTemplateEntry[] = [];
    for (const entry of INDUSTRY_TEMPLATE_MAP) {
        const industryKey = entry.keywords[0] ?? "general";
        for (const template of entry.templates) {
            entries.push({ template, industryKey });
        }
    }
    // Add default suggestions tagged with "general"
    for (const template of DEFAULT_SUGGESTIONS) {
        entries.push({ template, industryKey: "general" });
    }
    return entries;
}
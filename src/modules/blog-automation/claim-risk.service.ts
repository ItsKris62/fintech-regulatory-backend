export function extractRiskyClaims(content: string | null): Array<{ excerpt: string; claimText: string }> {
  if (!content) return [];

  const riskyTerms = [
    'must',
    'shall',
    'required',
    'requires',
    'mandatory',
    'obligated',
    'prohibited',
    'ban',
    'illegal',
    'deadline',
    'fine',
    'penalty',
    'sanction',
    'license',
    'licensing',
    'reporting obligation',
    'suspicious transaction',
    'data controller',
    'data processor',
    'compliance obligation',
    'audit requirement',
    'enforcement action',
    'revocation',
    'suspension'
  ];

  const sentences = content
    .replace(/\n/g, ' ')
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  const claims: Array<{ excerpt: string; claimText: string }> = [];

  for (const sentence of sentences) {
    const lowerSentence = sentence.toLowerCase();
    const foundTerms = riskyTerms.filter(term => lowerSentence.includes(term));

    if (foundTerms.length > 0) {
      claims.push({
        excerpt: sentence,
        claimText: `Contains risky obligation terms: ${foundTerms.join(', ')}`
      });
    }
  }

  return claims;
}

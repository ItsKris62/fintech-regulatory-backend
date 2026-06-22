import {
  BlogSourceItem,
  BlogSourceMonitor,
  BlogSuggestionPriority,
  BlogArticleType,
  BlogSourceQuality,
} from '@prisma/client';

export type ScoringInput = BlogSourceItem & { monitor: BlogSourceMonitor };

export type ScoringResult = {
  relevanceScore: number;
  priority: BlogSuggestionPriority;
  category: string;
  articleType: BlogArticleType;
  sourceQuality: BlogSourceQuality;
  recommendedTitle: string;
  suggestedSlug: string;
  recommendedTags: string[];
  targetAudience: string[];
  reason: string;
  suggestedNextAction: string;
  requiresOfficialSource: boolean;
  needsMoreSources: boolean;
};

export function scoreSourceItemForBlogSuggestion(item: ScoringInput): ScoringResult {
  let score = 0;
  let reasonDetails: string[] = [];

  const textToScan = `${item.title} ${item.summary || ''}`.toLowerCase();

  // 1. Source authority score
  let sourceQuality: BlogSourceQuality = BlogSourceQuality.MEDIUM;
  switch (item.sourceType) {
    case 'OFFICIAL':
      score += 30;
      sourceQuality = BlogSourceQuality.OFFICIAL;
      reasonDetails.push('+30 Official source');
      break;
    case 'INTERNATIONAL_STANDARD':
      score += 25;
      sourceQuality = BlogSourceQuality.HIGH;
      reasonDetails.push('+25 International standard');
      break;
    case 'INTERNAL':
      score += 15;
      sourceQuality = BlogSourceQuality.MEDIUM;
      reasonDetails.push('+15 Internal source');
      break;
    case 'THIRD_PARTY':
      score += 10;
      sourceQuality = BlogSourceQuality.MEDIUM;
      reasonDetails.push('+10 Third party source');
      break;
    case 'MEDIA':
      score += 5;
      sourceQuality = BlogSourceQuality.LOW;
      reasonDetails.push('+5 Media source');
      break;
  }

  // 2. Authority type score
  switch (item.authorityType) {
    case 'CENTRAL_BANK':
    case 'DATA_PROTECTION':
    case 'AML_CFT':
      score += 20;
      reasonDetails.push(`+20 High impact authority (${item.authorityType})`);
      break;
    case 'GAZETTE':
    case 'INTERNATIONAL_STANDARD':
      score += 18;
      reasonDetails.push(`+18 Standard/Gazette authority (${item.authorityType})`);
      break;
    case 'SECURITIES':
    case 'LEGAL_DATABASE':
      score += 15;
      reasonDetails.push(`+15 Medium impact authority (${item.authorityType})`);
      break;
    case 'COMMUNICATIONS':
      score += 12;
      reasonDetails.push(`+12 Comms authority`);
      break;
    case 'CONSUMER_PROTECTION':
    case 'COMPETITION':
      score += 10;
      reasonDetails.push(`+10 ${item.authorityType}`);
      break;
    case 'DEVELOPMENT_FINANCE':
      score += 8;
      reasonDetails.push('+8 Development finance');
      break;
    case 'INDUSTRY_BODY':
      score += 7;
      reasonDetails.push('+7 Industry body');
      break;
  }

  // 3. Keyword score
  const highPriorityKeywords = [
    'regulation', 'regulations', 'guideline', 'guidelines', 'circular',
    'directive', 'license', 'licensing', 'compliance', 'enforcement',
    'penalty', 'sanction', 'aml', 'cft', 'kyc', 'suspicious transaction',
    'data protection', 'privacy', 'cybersecurity', 'payment service',
    'digital credit', 'fintech', 'mobile money', 'consumer protection',
    'reporting', 'audit', 'risk management'
  ];

  let keywordScore = 0;
  let matchedKeywords: string[] = [];
  for (const kw of highPriorityKeywords) {
    if (textToScan.includes(kw)) {
      keywordScore += 5;
      matchedKeywords.push(kw);
    }
  }
  if (keywordScore > 20) keywordScore = 20; // Cap keyword score
  if (keywordScore > 0) {
    score += keywordScore;
    reasonDetails.push(`+${keywordScore} Keywords matched: ${matchedKeywords.slice(0, 3).join(', ')}`);
  }

  // 4. Recency score
  const now = new Date();
  const pubDate = item.publicationDate || item.discoveredAt;
  const daysOld = Math.floor((now.getTime() - pubDate.getTime()) / (1000 * 60 * 60 * 24));
  
  if (daysOld <= 30) {
    score += 15;
    reasonDetails.push('+15 Recent (<= 30 days)');
  } else if (daysOld <= 90) {
    score += 10;
    reasonDetails.push('+10 Recent (<= 90 days)');
  } else if (daysOld <= 180) {
    score += 5;
    reasonDetails.push('+5 Within 6 months');
  }

  // 5. Jurisdiction score
  if (['KE', 'MW', 'RW', 'NG'].includes(item.jurisdiction)) {
    score += 10;
    reasonDetails.push(`+10 Primary jurisdiction (${item.jurisdiction})`);
  } else if (item.jurisdiction === 'REGIONAL') {
    score += 8;
    reasonDetails.push('+8 Regional jurisdiction');
  } else if (item.jurisdiction === 'GLOBAL') {
    score += 6;
    reasonDetails.push('+6 Global jurisdiction');
  }

  // 6. Penalty/enforcement urgency
  let category = 'Regulatory Updates';
  let articleType: BlogArticleType = BlogArticleType.SINGLE_JURISDICTION_UPDATE;
  
  const enforcementWords = ['penalty', 'fine', 'enforcement', 'sanction', 'suspension', 'revocation', 'warning notice'];
  const hasEnforcement = enforcementWords.some(w => textToScan.includes(w));
  if (hasEnforcement) {
    score += 15;
    category = 'Enforcement & Penalties';
    reasonDetails.push('+15 Enforcement signals');
  }

  // 7. Regulatory update signals
  const updateWords = ['new regulation', 'guideline', 'circular', 'directive', 'framework', 'public notice', 'gazette notice'];
  const hasUpdate = updateWords.some(w => textToScan.includes(w));
  if (hasUpdate && !hasEnforcement) {
    score += 10;
    category = 'Regulatory Updates';
    reasonDetails.push('+10 Update signals');
  }

  // 8. Practical guide signals
  const guideWords = ['checklist', 'guide', 'requirements', 'obligations', 'how to comply', 'reporting'];
  const hasGuide = guideWords.some(w => textToScan.includes(w));
  if (hasGuide && !hasEnforcement) {
    category = 'Compliance Guides';
  }

  // Determine Category overrides & Article Types
  if (item.jurisdiction === 'REGIONAL') {
    articleType = BlogArticleType.REGIONAL_TREND_ANALYSIS;
  } else if (item.jurisdiction === 'GLOBAL' && item.sourceType === 'INTERNATIONAL_STANDARD') {
    articleType = BlogArticleType.EVERGREEN_EXPLAINER;
    category = 'International Standards';
  } else if (item.sourceType === 'OFFICIAL' && ['KE', 'MW', 'RW', 'NG'].includes(item.jurisdiction)) {
    articleType = BlogArticleType.SINGLE_JURISDICTION_UPDATE;
  }
  
  if (hasGuide) {
    articleType = BlogArticleType.COUNTRY_SPECIFIC_GUIDE;
  }

  // 9. Caps and thresholds
  if (score > 100) score = 100;
  if (score < 0) score = 0;

  let priority: BlogSuggestionPriority = BlogSuggestionPriority.LOW;
  if (score >= 85) priority = BlogSuggestionPriority.URGENT;
  else if (score >= 70) priority = BlogSuggestionPriority.HIGH;
  else if (score >= 45) priority = BlogSuggestionPriority.MEDIUM;

  // Title generation
  const countryMap: Record<string, string> = {
    KE: 'Kenya', MW: 'Malawi', RW: 'Rwanda', NG: 'Nigeria', REGIONAL: 'Africa', GLOBAL: 'Global'
  };
  const country = countryMap[item.jurisdiction] || item.jurisdiction;
  const shortTitle = item.title.substring(0, 50).replace(/[^a-zA-Z0-9 ]/g, '').trim();
  
  let recommendedTitle = `${country}: What This Update Means for Fintech`;
  if (hasEnforcement) {
    recommendedTitle = `${country}: Enforcement Action & Compliance Lessons`;
  } else if (category === 'Compliance Guides') {
    recommendedTitle = `${country}: Compliance Guide for ${item.monitor.name} Updates`;
  } else if (item.jurisdiction === 'GLOBAL') {
    recommendedTitle = `${item.monitor.name} Update: What African Fintech Teams Should Watch`;
  }

  // Slug generation
  const suggestedSlug = `${country.toLowerCase()}-${shortTitle.toLowerCase().replace(/\s+/g, '-')}-${Math.floor(Math.random() * 10000)}`;

  // Tags
  const tagsSet = new Set([country, item.monitor.name]);
  matchedKeywords.slice(0, 3).forEach(k => tagsSet.add(k.charAt(0).toUpperCase() + k.slice(1)));
  if (hasEnforcement) tagsSet.add('Enforcement');
  
  // Audience
  const targetAudience = ['Compliance Teams', 'Legal Teams', 'Fintech Startups'];

  return {
    relevanceScore: score,
    priority,
    category,
    articleType,
    sourceQuality,
    recommendedTitle,
    suggestedSlug,
    recommendedTags: Array.from(tagsSet),
    targetAudience,
    reason: reasonDetails.join('\n'),
    suggestedNextAction: 'Review source for draft approval.',
    requiresOfficialSource: item.sourceType !== 'OFFICIAL',
    needsMoreSources: false,
  };
}

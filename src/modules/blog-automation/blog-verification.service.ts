import { BlogVerificationStatus, BlogVerificationIssueType, BlogVerificationIssueSeverity, BlogVerificationRunType } from '@prisma/client';
import type { prisma as appPrisma } from '@/lib/prisma/client';
import { extractRiskyClaims } from './claim-risk.service';
import { blogNotificationService } from './blog-notification.service';

type BlogAutomationPrisma = typeof appPrisma;

export async function runBlogPostVerification({
  prisma,
  blogPostId,
  requestedByUserId,
  runType = 'MANUAL',
  useAiReview = false,
}: {
  prisma: BlogAutomationPrisma;
  blogPostId: string;
  requestedByUserId?: string;
  runType?: BlogVerificationRunType;
  useAiReview?: boolean;
}) {
  const post = await prisma.blogPost.findUnique({
    where: { id: blogPostId },
    include: {
      sources: true,
      draftGenerationRuns: {
        orderBy: { createdAt: 'desc' },
        take: 1
      }
    }
  });

  if (!post || post.deletedAt) {
    throw new Error('Blog post not found');
  }

  const run = await prisma.blogVerificationRun.create({
    data: {
      blogPostId,
      draftGenerationRunId: post.draftGenerationRuns[0]?.id,
      runType,
      status: 'RUNNING',
      requestedById: requestedByUserId,
    }
  });

  try {
    const issues: Array<{ severity: BlogVerificationIssueSeverity, issueType: BlogVerificationIssueType, title: string, description: string, excerpt?: string }> = [];

    // --- TASK 5: Source Validity Checks ---
    if (post.sources.length === 0) {
      issues.push({
        severity: 'BLOCKING',
        issueType: 'MISSING_SOURCE',
        title: 'Missing Sources',
        description: 'No sources attached to this blog post.'
      });
    }

    let hasOfficialSource = false;
    for (const source of post.sources) {
      if (source.sourceType === 'OFFICIAL' || source.sourceType === 'INTERNATIONAL_STANDARD') {
        hasOfficialSource = true;
      }
      
      const url = source.url || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        issues.push({
          severity: 'BLOCKING',
          issueType: 'INVALID_SOURCE_URL',
          title: 'Invalid Source URL',
          description: `Source URL is malformed: ${url}`,
          excerpt: url
        });
      }

      const placeholders = ['example.com', 'localhost', '127.0.0.1', '0.0.0.0', '::1', 'placeholder', 'todo', 'tbd'];
      if (placeholders.some(p => url.toLowerCase().includes(p))) {
        issues.push({
          severity: 'BLOCKING',
          issueType: 'PLACEHOLDER_SOURCE_URL',
          title: 'Placeholder Source URL',
          description: `Source URL contains placeholder domain: ${url}`,
          excerpt: url
        });
      }

      if (!source.publishedAt && source.sourceType === 'OFFICIAL') {
        issues.push({
          severity: 'WARNING',
          issueType: 'UNKNOWN_PUBLICATION_DATE',
          title: 'Unknown Publication Date',
          description: `Official source is missing publication date: ${source.title}`
        });
      }
    }

    if (['Regulatory Updates', 'Enforcement & Penalties'].includes(post.category) && !hasOfficialSource) {
      issues.push({
        severity: 'BLOCKING',
        issueType: 'MISSING_OFFICIAL_SOURCE',
        title: 'Missing Official Source',
        description: `${post.category} category requires an OFFICIAL source.`
      });
    }

    if (post.category === 'International Standards' && !hasOfficialSource) {
      issues.push({
        severity: 'BLOCKING',
        issueType: 'MISSING_OFFICIAL_SOURCE',
        title: 'Missing Official Source',
        description: `International Standards category requires an OFFICIAL or INTERNATIONAL_STANDARD source.`
      });
    }

    if (post.sources.length === 1 && ['Regulatory Updates', 'Enforcement & Penalties'].includes(post.category)) {
      issues.push({
        severity: 'WARNING',
        issueType: 'WEAK_SOURCE_COVERAGE',
        title: 'Weak Source Coverage',
        description: 'Only one source attached for a high-risk category.'
      });
    }

    // --- TASK 6: Jurisdiction Consistency Checks ---
    if (!post.jurisdiction) {
      issues.push({
        severity: 'BLOCKING',
        issueType: 'JURISDICTION_MISMATCH',
        title: 'Missing Jurisdiction',
        description: 'The blog post jurisdiction is missing.'
      });
    }

    // Advanced jurisdiction checks skipped due to complex metadata requirements for now, but a placeholder rule:
    const isRegionalGlobal = post.jurisdiction === 'Global' || post.jurisdiction === 'Regional' || post.jurisdiction === 'Africa';
    if (!isRegionalGlobal && post.jurisdiction !== 'Kenya' && post.jurisdiction !== 'Nigeria' && post.jurisdiction !== 'Malawi' && post.jurisdiction !== 'Rwanda') {
      issues.push({
        severity: 'WARNING',
        issueType: 'JURISDICTION_MISMATCH',
        title: 'Unknown Jurisdiction',
        description: `The jurisdiction '${post.jurisdiction}' is not standard.`
      });
    }

    // --- TASK 7: Content Structure Checks ---
    if (!post.content || post.content.trim().length === 0) {
      issues.push({
        severity: 'BLOCKING',
        issueType: 'EMPTY_CONTENT',
        title: 'Empty Content',
        description: 'The blog post content is empty.'
      });
    } else {
      const wordCount = post.content.split(/\s+/).length;
      if (wordCount < 300 && post.category !== 'Product Updates') {
        issues.push({
          severity: 'WARNING',
          issueType: 'EMPTY_CONTENT',
          title: 'Short Content',
          description: `Content is only ${wordCount} words. A minimum of 300 words is recommended.`
        });
      }

      const disclaimerPhrases = ['general informational purposes', 'does not constitute legal advice', 'consult a qualified legal or compliance professional', 'informational purposes only'];
      const hasDisclaimer = disclaimerPhrases.some(phrase => post.content!.toLowerCase().includes(phrase));
      if (!hasDisclaimer) {
        issues.push({
          severity: 'BLOCKING',
          issueType: 'MISSING_DISCLAIMER',
          title: 'Missing Disclaimer',
          description: 'No legal disclaimer found in the content.'
        });
      }
      
      const aiWarningPhrases = ['ai-assisted', 'ai generated', 'artificial intelligence'];
      const hasAiWarning = aiWarningPhrases.some(phrase => post.content!.toLowerCase().includes(phrase));
      if (post.draftGenerationRuns.length > 0 && !hasAiWarning) {
        issues.push({
          severity: 'WARNING',
          issueType: 'MISSING_AI_REVIEW_WARNING',
          title: 'Missing AI Warning',
          description: 'AI generation run exists but no AI warning detected in text.'
        });
      }
    }

    // --- TASK 8: Claim-Risk Extraction ---
    const riskyClaims = extractRiskyClaims(post.content);
    for (const claim of riskyClaims) {
      issues.push({
        severity: 'WARNING',
        issueType: 'RISKY_LEGAL_CLAIM',
        title: 'Risky Legal Claim',
        description: claim.claimText,
        excerpt: claim.excerpt
      });
      if (!hasOfficialSource) {
         issues.push({
          severity: 'BLOCKING',
          issueType: 'RISKY_LEGAL_CLAIM',
          title: 'Risky Claim Without Official Source',
          description: 'A risky claim was made but no official source is attached.',
          excerpt: claim.excerpt
        });
      }
    }

    // --- Optional AI-Assisted Verification ---
    if (useAiReview) {
      // In a real scenario, we'd call Anthropic API here.
      // For now, if implemented, we just log we would have used it or handle it gracefully.
      // We are skipping direct API integration to avoid unnecessary external calls unless strictly needed.
    }

    // --- TASK 10: Scoring and Final Status Logic ---
    let sourceScore = 100;
    let jurisdictionScore = 100;
    let claimRiskScore = 100;
    let readinessScore = 100;

    const blockingIssues = issues.filter(i => i.severity === 'BLOCKING');
    const warningIssues = issues.filter(i => i.severity === 'WARNING');
    const infoIssues = issues.filter(i => i.severity === 'INFO');

    for (const issue of issues) {
      if (issue.issueType === 'MISSING_SOURCE') sourceScore -= 100;
      if (issue.issueType === 'MISSING_OFFICIAL_SOURCE') sourceScore -= 60;
      if (issue.issueType === 'PLACEHOLDER_SOURCE_URL') sourceScore -= 50;
      if (issue.issueType === 'INVALID_SOURCE_URL') sourceScore -= 40;
      if (issue.issueType === 'WEAK_SOURCE_COVERAGE') sourceScore -= 20;
      if (issue.issueType === 'UNKNOWN_PUBLICATION_DATE') sourceScore -= 10;
      
      if (issue.issueType === 'JURISDICTION_MISMATCH' && issue.severity === 'BLOCKING') jurisdictionScore -= 70;
      if (issue.issueType === 'JURISDICTION_MISMATCH' && issue.severity === 'WARNING') jurisdictionScore -= 20;

      if (issue.issueType === 'RISKY_LEGAL_CLAIM') {
        claimRiskScore -= 5;
        if (issue.severity === 'BLOCKING') claimRiskScore -= 30;
      }

      if (issue.issueType === 'MISSING_DISCLAIMER') readinessScore -= 40;
      if (issue.issueType === 'MISSING_AI_REVIEW_WARNING') readinessScore -= 20;
      if (issue.issueType === 'EMPTY_CONTENT' && issue.severity === 'WARNING') readinessScore -= 20;
      if (issue.issueType === 'EMPTY_CONTENT' && issue.severity === 'BLOCKING') readinessScore -= 100;
    }

    sourceScore = Math.max(0, sourceScore);
    jurisdictionScore = Math.max(0, jurisdictionScore);
    claimRiskScore = Math.max(0, claimRiskScore);
    readinessScore = Math.max(0, readinessScore);

    const qualityScore = Math.round((sourceScore + jurisdictionScore + claimRiskScore + readinessScore) / 4);

    let finalStatus: BlogVerificationStatus = 'PASSED';
    let recommendedAction = 'Ready for editor/legal review. Manual approval still required.';

    if (blockingIssues.length > 0) {
      finalStatus = 'BLOCKED';
      recommendedAction = 'Resolve blocking issues before publication.';
    } else if (warningIssues.length > 0 || qualityScore < 85) {
      finalStatus = 'NEEDS_REVIEW';
      recommendedAction = 'Human review required before publication.';
    }

    const updatedRun = await prisma.blogVerificationRun.update({
      where: { id: run.id },
      data: {
        status: finalStatus,
        qualityScore,
        sourceScore,
        jurisdictionScore,
        claimRiskScore,
        readinessScore,
        blockingIssueCount: blockingIssues.length,
        warningIssueCount: warningIssues.length,
        infoIssueCount: infoIssues.length,
        summary: `Verification completed with ${blockingIssues.length} blockers and ${warningIssues.length} warnings.`,
        recommendedAction,
        completedAt: new Date(),
        issues: {
          create: issues.map(i => ({
            severity: i.severity,
            issueType: i.issueType,
            title: i.title,
            description: i.description,
            excerpt: i.excerpt
          }))
        }
      },
      include: {
        issues: true
      }
    });

    if (finalStatus === 'BLOCKED' && post.authorId) {
      // Notify the author or the admin who requested it
      const adminId = requestedByUserId || post.authorId;
      await blogNotificationService.notifyVerificationBlocked(
        adminId,
        post.id,
        `${blockingIssues.length} blocking issues found.`
      ).catch(console.error);
    }

    return updatedRun;
  } catch (error: any) {
    await prisma.blogVerificationRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        errorMessage: error.message,
        completedAt: new Date()
      }
    });
    throw error;
  }
}

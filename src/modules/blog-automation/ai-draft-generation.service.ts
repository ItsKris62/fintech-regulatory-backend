import { prisma } from '../../lib/prisma/client';
import { complete } from '../../lib/ai/client';
import { getBlogDraftUserPrompt, BLOG_DRAFT_SYSTEM_PROMPT } from './blog-draft-prompt';
import { blogNotificationService } from './blog-notification.service';

export async function generateAiDraftForBlogPost(blogPostId: string, adminUserId: string) {
  const post = await prisma.blogPost.findUnique({
    where: { id: blogPostId },
    include: {
      sources: true,
    }
  });

  if (!post) {
    throw new Error('BlogPost not found');
  }

  if (post.status !== 'DRAFT' && post.status !== 'IN_REVIEW') {
    throw new Error('AI generation is only allowed for DRAFT or IN_REVIEW posts');
  }

  if (post.sources.length === 0) {
    throw new Error('AI generation requires attached BlogPostSource records');
  }

  const promptInput = {
    title: post.title,
    excerpt: post.excerpt,
    jurisdiction: post.jurisdiction,
    category: post.category,
    tags: post.tags,
    sources: (post.sources as any[]).map(s => ({
      title: s.title,
      publisher: s.publisher,
      url: s.url,
      publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
      notes: s.notes,
    })),
  };

  const userPrompt = getBlogDraftUserPrompt(promptInput);

  // Track the run
  const run = await prisma.blogDraftGenerationRun.create({
    data: {
      blogPostId: post.id,
      inputTokenEstimate: null, // Will update if Anthropic client returns them
      outputTokenEstimate: null,
      costUsdEstimate: null,
      status: 'PENDING',
      startedAt: new Date(),
      requestedById: adminUserId,
    }
  });

  try {
    const aiResponse = await complete({
      prompt: userPrompt,
      systemPrompt: BLOG_DRAFT_SYSTEM_PROMPT,
      model: 'claude-3-5-sonnet-20240620',
      temperature: 0.2, // Low temp for regulatory content
    });

    // Extract JSON from response (sometimes Claude wraps in markdown blocks)
    let jsonStr = aiResponse.content;
    const jsonMatch = aiResponse.content.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    } else {
      // attempt raw parse
      const startIdx = aiResponse.content.indexOf('{');
      const endIdx = aiResponse.content.lastIndexOf('}');
      if (startIdx >= 0 && endIdx >= 0) {
        jsonStr = aiResponse.content.substring(startIdx, endIdx + 1);
      }
    }

    const result = JSON.parse(jsonStr) as {
      title: string;
      excerpt: string;
      seoTitle: string;
      seoDescription: string;
      tags: string[];
      markdown: string;
      reviewerNotes: string;
      uncertaintyFlags: string[];
    };

    // Update the run success
    await prisma.blogDraftGenerationRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCESS',
        completedAt: new Date(),
        reviewerNotes: result.reviewerNotes,
        uncertaintyFlags: result.uncertaintyFlags,
      }
    });

    // We do NOT update the post automatically, but we will return the generated content
    // so the caller can apply it, or we apply it to the draft directly since it's a DRAFT.
    // The requirement: "Failed AI generation must not overwrite existing draft content."
    // "AI generation must never publish or change the post status."
    
    // We update the content of the draft post.
    const updatedPost = await prisma.blogPost.update({
      where: { id: post.id },
      data: {
        title: result.title,
        excerpt: result.excerpt,
        seoTitle: result.seoTitle,
        seoDescription: result.seoDescription,
        tags: result.tags,
        content: result.markdown,
        updatedById: adminUserId,
      }
    });

    // Notify that draft is ready for verification
    await blogNotificationService.notifyDraftReadyForVerification(
      adminUserId,
      post.id
    ).catch(console.error);

    return {
      post: updatedPost,
      runId: run.id,
      reviewerNotes: result.reviewerNotes,
      uncertaintyFlags: result.uncertaintyFlags,
    };

  } catch (error: any) {
    // Record failure
    await prisma.blogDraftGenerationRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMessage: error.message || 'Unknown error during AI generation',
      }
    });
    throw new Error(`AI generation failed: ${error.message}`);
  }
}

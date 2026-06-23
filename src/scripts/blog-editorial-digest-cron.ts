import { prisma } from '../lib/prisma/client';
import { blogEditorialDigestService } from '../modules/blog-automation/blog-editorial-digest.service';
import { logger } from '../utils/logger';

async function run() {
  logger.info({ type: 'blog_digest_cron_started' });
  try {
    const digest = await blogEditorialDigestService.generateBlogEditorialDigest();
    logger.info({ type: 'blog_digest_cron_success', digestId: digest.id });
  } catch (error) {
    logger.error({ type: 'blog_digest_cron_error', error: (error as Error).message });
    process.exitCode = 1;
  }
}

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

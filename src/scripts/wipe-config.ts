import { prisma } from '../lib/prisma/client';
import { redis } from '../lib/redis/client';

async function wipeConfig() {
  await prisma.systemConfig.deleteMany({
    where: {
      key: { in: ['ai_query_model', 'aiQueryModel', 'availableAIModels', 'available_ai_models', 'aiVerificationModel', 'ai_verification_model', 'aiComplexAnalysisModel', 'ai_complex_analysis_model', 'aiPolicyModel', 'ai_policy_model'] }
    }
  });
  await redis.del('admin:system_config');
  await redis.del('admin:system_config:persisted');
  console.log("Deleted hardcoded DB system configs for AI models");
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

wipeConfig().catch(console.error);

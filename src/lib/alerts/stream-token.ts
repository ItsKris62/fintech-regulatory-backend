import { createHash, randomBytes } from 'crypto';
import { redis } from '@/lib/redis/client';

const STREAM_TOKEN_TTL_SECONDS = 60;
const STREAM_TOKEN_BYTES = 32;
const STREAM_TOKEN_KEY_PREFIX = 'alerts:stream-token:';

type AlertStreamTokenPayload = {
  userId: string;
  createdAt: number;
};

function streamTokenKey(token: string): string {
  const tokenHash = createHash('sha256').update(token).digest('hex');
  return `${STREAM_TOKEN_KEY_PREFIX}${tokenHash}`;
}

export async function createAlertStreamToken(userId: string): Promise<{
  token: string;
  expiresInSeconds: number;
}> {
  const token = randomBytes(STREAM_TOKEN_BYTES).toString('base64url');
  const payload: AlertStreamTokenPayload = {
    userId,
    createdAt: Date.now(),
  };

  await redis.set(streamTokenKey(token), JSON.stringify(payload), {
    ex: STREAM_TOKEN_TTL_SECONDS,
  });

  return {
    token,
    expiresInSeconds: STREAM_TOKEN_TTL_SECONDS,
  };
}

export async function consumeAlertStreamToken(token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) return null;

  const key = streamTokenKey(token);
  const payload = await redis.get<AlertStreamTokenPayload>(key);
  if (!payload || typeof payload !== 'object' || typeof payload.userId !== 'string') {
    return null;
  }

  await redis.del(key).catch(() => {});
  return payload.userId;
}

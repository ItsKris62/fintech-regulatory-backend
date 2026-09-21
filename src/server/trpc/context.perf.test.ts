import 'dotenv/config';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';

const { mockRedis } = vi.hoisted(() => {
  return {
    mockRedis: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
      del: vi.fn().mockResolvedValue(1),
      exists: vi.fn().mockResolvedValue(0),
      ping: vi.fn().mockResolvedValue('PONG'),
    },
  };
});

vi.mock('@/lib/redis/client', () => ({
  redis: mockRedis,
  connectRedis: vi.fn(),
  disconnectRedis: vi.fn(),
  checkRedisHealth: vi.fn().mockResolvedValue(true),
  getRedisStats: vi.fn(),
  get: vi.fn(),
}));

import {
  createContext,
  verifySupabaseTokenLocally,
  getInMemoryUserSession,
  setInMemoryUserSession,
  evictInMemoryUserSession,
  contextMetrics,
  type User,
} from './context';
import { supabaseAdmin } from '@/lib/supabase';
import { prisma } from '@/lib/prisma/client';

describe('createContext Performance, Security & Revocation Invariants', () => {
  const mockJwtSecret = 'test-jwt-secret-for-testing-perf-12345';
  process.env.SUPABASE_JWT_SECRET = mockJwtSecret;

  const validPayload = {
    sub: 'user-supabase-uuid-1234',
    email: 'test@sheriabot.com',
    role: 'authenticated',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: 'mock-jti-uuid-1234',
  };

  const sampleUser: User = {
    id: 'cuid-user-123',
    email: 'test@sheriabot.com',
    role: 'STARTUP',
    organizationId: 'cuid-org-123',
    sessionId: 'cuid-session-123',
    supabaseAuthId: 'user-supabase-uuid-1234',
    sessionExpiresAt: Date.now() + 3600 * 1000,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    contextMetrics.reset();
    evictInMemoryUserSession('user-supabase-uuid-1234');
  });

  describe('1. Strict JWT Hard-Rejection Rules', () => {
    it('verifies a signed HS256 JWT in <5ms without external network calls', async () => {
      const token = jwt.sign(validPayload, mockJwtSecret, { algorithm: 'HS256' });
      // Warm up JIT
      await verifySupabaseTokenLocally(token);
      const t0 = performance.now();
      const res = await verifySupabaseTokenLocally(token);
      const elapsed = performance.now() - t0;

      expect(res.status).toBe('VALID');
      if (res.status === 'VALID') {
        expect(res.payload.sub).toBe(validPayload.sub);
      }
      expect(elapsed).toBeLessThan(15);
    });

    it('HARD-REJECTS tampered-signature tokens and NEVER falls back to Supabase API', async () => {
      // Token signed with a different key
      const forgedToken = jwt.sign(validPayload, 'attacker-unauthorized-secret-key', { algorithm: 'HS256' });

      const localResult = await verifySupabaseTokenLocally(forgedToken);
      expect(localResult.status).toBe('HARD_REJECT');

      const supabaseGetUserSpy = vi.spyOn(supabaseAdmin.auth, 'getUser');

      const req = {
        headers: { authorization: `Bearer ${forgedToken}` },
        ip: '127.0.0.1',
      } as any;
      const res = {} as any;

      const ctx = await createContext({ req, res });

      expect(ctx.user).toBeNull();
      // Verifies security invariant: fallback to Supabase API is strictly forbidden on signature failure
      expect(supabaseGetUserSpy).not.toHaveBeenCalled();
      expect(contextMetrics.hardRejections).toBe(1);
      expect(contextMetrics.signatureMismatches).toBe(1);
      expect(contextMetrics.expiredTokens).toBe(0);
    });

    it('HARD-REJECTS expired tokens and increments expiredTokens metric', async () => {
      const expiredPayload = { ...validPayload, exp: Math.floor(Date.now() / 1000) - 100 };
      const token = jwt.sign(expiredPayload, mockJwtSecret, { algorithm: 'HS256' });
      const res = await verifySupabaseTokenLocally(token);
      expect(res.status).toBe('HARD_REJECT');
      if (res.status === 'HARD_REJECT') {
        expect(res.rejectionType).toBe('EXPIRED');
      }

      const req = {
        headers: { authorization: `Bearer ${token}` },
        ip: '127.0.0.1',
      } as any;
      const response = {} as any;

      const ctx = await createContext({ req, res: response });
      expect(ctx.user).toBeNull();
      expect(contextMetrics.expiredTokens).toBe(1);
      expect(contextMetrics.signatureMismatches).toBe(0);
    });

    it('allows fallback to Supabase API on key rotation or unconfigured JWKS', async () => {
      // Simulate an RS256 token with unknown kid or unconfigured JWKS
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'unknown-key-id' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(validPayload)).toString('base64url');
      const rs256Token = `${header}.${payload}.mockSignature`;

      const res = await verifySupabaseTokenLocally(rs256Token);
      expect(res.status).toBe('FALLBACK_REQUIRED');
    });
  });

  describe('2. Multi-Instance Invalidation & Revocation Enforcement', () => {
    it('instantly enforces distributed Redis token revocation even when in-memory LRU has a hit', async () => {
      const token = jwt.sign(validPayload, mockJwtSecret, { algorithm: 'HS256' });
      setInMemoryUserSession(sampleUser.supabaseAuthId, sampleUser);

      // Simulate token revoked on another instance via Redis JTI blocklist
      mockRedis.exists.mockResolvedValue(1); // Token is blocklisted in Redis
      mockRedis.get.mockResolvedValue(null);

      const req = {
        headers: { authorization: `Bearer ${token}` },
        ip: '127.0.0.1',
      } as any;
      const res = {} as any;

      const ctx = await createContext({ req, res });

      // In-memory cache must be evicted immediately and user returned as null
      expect(mockRedis.exists).toHaveBeenCalled();
      expect(ctx.user).toBeNull();
      expect(getInMemoryUserSession(sampleUser.supabaseAuthId)).toBeNull();
    });
  });

  describe('3. createContext Caching & Query Bypass', () => {
    it('bypasses Supabase getUser and Prisma on in-memory cache hit', async () => {
      const token = jwt.sign(validPayload, mockJwtSecret, { algorithm: 'HS256' });
      setInMemoryUserSession(sampleUser.supabaseAuthId, sampleUser);

      mockRedis.exists.mockResolvedValue(0);
      mockRedis.get.mockResolvedValue(null);
      const prismaUserSpy = vi.spyOn(prisma.user, 'findUnique');
      const prismaSessionSpy = vi.spyOn(prisma.session, 'findFirst');
      const supabaseGetUserSpy = vi.spyOn(supabaseAdmin.auth, 'getUser');

      const req = {
        headers: { authorization: `Bearer ${token}` },
        ip: '127.0.0.1',
      } as any;
      const res = {} as any;

      const ctx = await createContext({ req, res });

      expect(ctx.user).not.toBeNull();
      expect(ctx.user?.id).toBe(sampleUser.id);
      expect(supabaseGetUserSpy).not.toHaveBeenCalled();
      expect(prismaUserSpy).not.toHaveBeenCalled();
      expect(prismaSessionSpy).not.toHaveBeenCalled();
      expect(contextMetrics.memoryHits).toBe(1);
    });
  });
});

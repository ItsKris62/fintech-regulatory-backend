import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { prisma } from '@/lib/prisma/client';
import { aiService } from '@/lib/ai/ai.service';
import { ragService } from '@/lib/rag/rag.service';
import { storageService } from '@/lib/storage/storage.service';
import { mailer } from '@/lib/email/mailer.service';
import { logger } from '@/utils/logger';

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

/**
 * User information extracted from JWT
 */
export interface User {
  id: string;
  email: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
}

/**
 * tRPC Context
 * 
 * Provides authenticated user info (if available) and all Phase 1 services
 * to every tRPC procedure.
 */
export interface Context {
  // User info (null if not authenticated)
  user: User | null;
  
  // Phase 1 services
  prisma: typeof prisma;
  aiService: typeof aiService;
  ragService: typeof ragService;
  storageService: typeof storageService;
  mailer: typeof mailer;
  
  // Request/Response
  req: FastifyRequest;
  res: FastifyReply;
}

/**
 * Create tRPC context for each request
 * 
 * Extracts JWT from Authorization header, verifies it, and attaches
 * user info to context. Also provides all Phase 1 services.
 */
export async function createContext({
  req,
  res,
}: {
  req: FastifyRequest;
  res: FastifyReply;
}): Promise<Context> {
  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  let user: User | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    
    try {
      // Verify and decode JWT
      const decoded = jwt.verify(token, JWT_SECRET!) as unknown as {
        userId: string;
        email: string;
        role: string;
        organizationId?: string;
        sessionId?: string;
      };

      user = {
        id: decoded.userId,
        email: decoded.email,
        role: decoded.role,
        organizationId: decoded.organizationId,
        sessionId: decoded.sessionId,
      };

      logger.debug({
        type: 'context_user_authenticated',
        userId: user.id,
        role: user.role,
      });
    } catch (error: any) {
      // Invalid or expired token - user stays null
      logger.warn({
        type: 'context_invalid_token',
        error: error.message,
        ip: req.ip,
      });
    }
  }

  return {
    user,
    prisma,
    aiService,
    ragService,
    storageService,
    mailer,
    req,
    res,
  };
}
import { TRPCError } from '@trpc/server';

import { prisma } from '@/lib/prisma/client';
import { userCache } from '@/lib/redis/cache.service';
import { logger } from '@/utils/logger';
import {
  generateAvatarUploadUrl,
  deleteAvatarByKey,
  extractKeyFromAvatarUrl,
  type AvatarContentType,
} from '@/lib/storage/public-storage.service';

/* -------------------------------------------------------------------------- */
/*                              Return Types                                  */
/* -------------------------------------------------------------------------- */

export interface AvatarUploadUrlResult {
  uploadUrl: string;
  publicUrl: string;
}

export interface AvatarUpdateResult {
  avatar: string | null;
}

/* -------------------------------------------------------------------------- */
/*                            Pure Helper                                     */
/* -------------------------------------------------------------------------- */

/**
 * Derives a 1-2 character display string from a user's full name.
 *
 * Rules:
 * - Two words or more  -> first letter of word 1 + first letter of word 2
 * - Single word ≥ 2    -> first two characters
 * - Single char / null -> "U"
 *
 * Always returns uppercase.
 */
export function getInitials(fullName: string | null | undefined): string {
  if (!fullName?.trim()) return 'U';

  const parts = fullName.trim().split(/\s+/);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  const word = parts[0];
  return word.length >= 2 ? word.slice(0, 2).toUpperCase() : word[0].toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*                           Avatar Service                                   */
/* -------------------------------------------------------------------------- */

export const avatarService = {
  /**
   * Generates a presigned PUT URL so the browser can upload directly to R2.
   * Does NOT touch the database  -  the URL is valid for 5 minutes.
   * Call `confirmUpload` after the browser PUT succeeds.
   */
  async getUploadUrl(
    userId: string,
    contentType: AvatarContentType,
    fileSize: number,
  ): Promise<AvatarUploadUrlResult> {
    const { uploadUrl, publicUrl } = await generateAvatarUploadUrl(userId, contentType, fileSize);

    logger.info({ type: 'avatar_upload_url_requested', userId });

    return { uploadUrl, publicUrl };
  },

  /**
   * Persists the avatar URL in the database after a successful R2 upload.
   * Validates that the URL belongs to the configured public bucket before saving.
   * Clears the user profile cache so the next `getProfile` call returns fresh data.
   */
  async confirmUpload(userId: string, publicUrl: string): Promise<AvatarUpdateResult> {
    // Verify the URL actually points at our R2 bucket key space
    const key = extractKeyFromAvatarUrl(publicUrl);
    if (!key || !key.startsWith(`avatars/${userId}/`)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Invalid avatar URL  -  must belong to your account.',
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { avatar: publicUrl, updatedAt: new Date() },
    });

    await userCache.delete(userId);

    logger.info({ type: 'avatar_confirmed', userId, key });

    return { avatar: publicUrl };
  },

  /**
   * Deletes the user's current avatar from R2 and clears the DB field.
   * Safe to call when no avatar is set  -  returns early without error.
   */
  async deleteAvatar(userId: string): Promise<AvatarUpdateResult> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatar: true },
    });

    if (!user?.avatar) {
      // Nothing to delete  -  idempotent no-op
      return { avatar: null };
    }

    const key = extractKeyFromAvatarUrl(user.avatar);

    if (key) {
      // Best-effort deletion: don't fail the request if R2 object is already gone
      await deleteAvatarByKey(key).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ type: 'avatar_r2_delete_warn', userId, key, error: message });
      });
    } else {
      logger.warn({
        type: 'avatar_key_extract_failed',
        userId,
        avatarUrl: user.avatar,
      });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { avatar: null, updatedAt: new Date() },
    });

    await userCache.delete(userId);

    logger.info({ type: 'avatar_deleted_from_profile', userId });

    return { avatar: null };
  },
};

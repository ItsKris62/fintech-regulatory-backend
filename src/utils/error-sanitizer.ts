import { Prisma } from '@prisma/client';

const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

function isPrismaKnownRequestError(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError;
}

export function isPrismaForeignKeyError(error: unknown): boolean {
  return isPrismaKnownRequestError(error) && error.code === 'P2003';
}

export function sanitizeErrorMessage(error: unknown, fallback = GENERIC_ERROR_MESSAGE): string {
  if (isPrismaForeignKeyError(error)) {
    return 'The selected organization could not be found.';
  }

  if (isPrismaKnownRequestError(error)) {
    return fallback;
  }

  if (error instanceof Error) {
    const message = error.message.trim();

    if (
      message.includes('Invalid `prisma.') ||
      message.includes('Foreign key constraint') ||
      message.includes('/opt/render/') ||
      message.includes('\\dist\\') ||
      message.includes('/dist/')
    ) {
      return fallback;
    }

    return message || fallback;
  }

  return fallback;
}

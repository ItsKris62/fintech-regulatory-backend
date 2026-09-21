import { z } from 'zod';

export const generateRegistrationOptionsSchema = z.void();

export const verifyRegistrationSchema = z.object({
  response: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      attestationObject: z.string().min(1),
      transports: z.array(z.string()).optional(),
      authenticatorData: z.string().optional(),
    }),
    authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.any()).optional(),
    type: z.literal('public-key'),
  }),
  deviceName: z.string().min(1).max(64).trim().optional(),
});

export const generateAuthenticationOptionsSchema = z.object({
  userHandle: z.string().optional(),
});

export const verifyAuthenticationSchema = z.object({
  challengeId: z.string().min(1),
  response: z.object({
    id: z.string().min(1),
    rawId: z.string().min(1),
    response: z.object({
      clientDataJSON: z.string().min(1),
      authenticatorData: z.string().min(1),
      signature: z.string().min(1),
      userHandle: z.string().nullable().optional(),
    }),
    authenticatorAttachment: z.enum(['cross-platform', 'platform']).optional(),
    clientExtensionResults: z.record(z.string(), z.any()).optional(),
    type: z.literal('public-key'),
  }),
});

export const renamePasskeySchema = z.object({
  id: z.string().min(1),
  deviceName: z.string().min(1, 'Device name is required').max(64, 'Device name cannot exceed 64 characters').trim(),
});

export const deletePasskeySchema = z.object({
  id: z.string().min(1),
});

export type VerifyRegistrationInput = z.infer<typeof verifyRegistrationSchema>;
export type GenerateAuthenticationOptionsInput = z.infer<typeof generateAuthenticationOptionsSchema>;
export type VerifyAuthenticationInput = z.infer<typeof verifyAuthenticationSchema>;
export type RenamePasskeyInput = z.infer<typeof renamePasskeySchema>;
export type DeletePasskeyInput = z.infer<typeof deletePasskeySchema>;

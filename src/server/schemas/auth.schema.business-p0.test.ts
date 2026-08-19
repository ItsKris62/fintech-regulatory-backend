import { describe, expect, it } from 'vitest';
import { registerSchema } from './auth.schema';

const validRegistration = {
  email: 'user@example.co.ke',
  password: 'Str0ngPassw0rd!',
  name: 'Jane User',
  role: 'STARTUP' as const,
};

describe('registerSchema Business P0 contract', () => {
  it('rejects public organizationId attachment', () => {
    expect(() => registerSchema.parse({
      ...validRegistration,
      organizationId: 'org_1',
    })).toThrow();
  });

  it('accepts an invitation token for token-bound organization joins', () => {
    expect(registerSchema.parse({
      ...validRegistration,
      invitationToken: 'a'.repeat(64),
    })).toMatchObject({
      invitationToken: 'a'.repeat(64),
    });
  });
});

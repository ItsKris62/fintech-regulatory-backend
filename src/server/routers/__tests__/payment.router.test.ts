import { describe, expect, it, vi, beforeEach } from 'vitest';
import { paymentRouter } from '../payment.router';
import { paymentService } from '@/modules/billing/payment.service';
import { PaymentProvider, PaymentStatus } from '@prisma/client';

const testOrgId = 'org_test_pay_123';
const testUserId = 'user_test_pay_456';

vi.mock('@/lib/prisma/client', () => ({
  prisma: {
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_test_pay_123',
        userId: 'user_test_pay_456',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
      findFirst: vi.fn().mockResolvedValue({
        id: 'member_1',
        organizationId: 'org_test_pay_123',
        userId: 'user_test_pay_456',
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'org_test_pay_123',
        name: 'Acme Regulatory Inc',
        status: 'ACTIVE',
      }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user_test_pay_456',
        email: 'payer@example.com',
        fullName: 'Jane Doe',
        role: 'STARTUP',
        organizationId: 'org_test_pay_123',
      }),
    },
    systemConfig: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: 'audit_1' }),
    },
  },
}));

vi.mock('@/modules/billing/payment.service', () => ({
  paymentService: {
    getPaymentsByOrg: vi.fn(),
    getPaymentById: vi.fn(),
  },
}));

vi.mock('@/lib/redis/client', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

vi.mock('@/lib/redis/rate-limiter', () => ({
  rateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
  authRateLimiter: {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

describe('Payment Router (Tenant-Scoped Invariants)', () => {
  const mockTenantPrisma = {
    payment: {
      findFirst: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  } as any;

  const mockCtx = {
    user: {
      id: testUserId,
      email: 'payer@example.com',
      role: 'STARTUP',
      organizationId: testOrgId,
      supabaseAuthId: 'supa_auth_123',
    },
    orgMembership: {
      id: 'mem_123',
      organizationId: testOrgId,
      userId: testUserId,
      status: 'ACTIVE',
      role: 'ADMIN',
    },
    req: {
      headers: { 'user-agent': 'vitest-test-agent' },
      ip: '127.0.0.1',
    },
    tenantPrisma: mockTenantPrisma,
    prisma: {
      organization: {
        findUnique: vi.fn().mockResolvedValue({
          id: testOrgId,
          name: 'Acme Regulatory Inc',
          status: 'ACTIVE',
        }),
      },
      organizationMember: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'mem_123',
          organizationId: testOrgId,
          userId: testUserId,
          status: 'ACTIVE',
          role: 'ADMIN',
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: 'mem_123',
          organizationId: testOrgId,
          userId: testUserId,
          status: 'ACTIVE',
          role: 'ADMIN',
        }),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue({
          fullName: 'Jane Doe',
          email: 'payer@example.com',
        }),
      },
    },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists paginated payments scoped strictly to the authenticated user organization', async () => {
    const mockPayment = {
      id: 'pay_1',
      provider: PaymentProvider.MPESA,
      providerTransactionId: 'WS12345',
      amount: 5000,
      currency: 'KES',
      status: PaymentStatus.COMPLETED,
      paymentPurpose: 'SUBSCRIPTION',
      description: 'Monthly Plan',
      paidAt: new Date('2026-09-01T10:00:00Z'),
      createdAt: new Date('2026-09-01T09:59:00Z'),
      metadata: { phone_number: '254712345678' },
      invoiceNumber: 'INV-2026-001',
      subscriptionPlan: 'PRO',
      billingPeriodStart: new Date('2026-09-01T00:00:00Z'),
      billingPeriodEnd: new Date('2026-10-01T00:00:00Z'),
    };

    (paymentService.getPaymentsByOrg as any).mockResolvedValue({
      payments: [mockPayment],
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });

    const caller = paymentRouter.createCaller(mockCtx);
    const result = await caller.list({ page: 1, limit: 10 });

    expect(paymentService.getPaymentsByOrg).toHaveBeenCalledWith({
      orgId: testOrgId,
      page: 1,
      limit: 10,
    });
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0].id).toBe('pay_1');
    expect(result.payments[0].invoiceNumber).toBe('INV-2026-001');
  });

  it('fetches single payment by ID scoped to the authenticated organization', async () => {
    const mockPayment = {
      id: 'pay_cuid_123456789012345678901234',
      provider: PaymentProvider.STRIPE,
      providerTransactionId: 'ch_stripe_123',
      amount: 100,
      currency: 'USD',
      status: PaymentStatus.COMPLETED,
      paymentPurpose: 'SUBSCRIPTION',
      description: 'Annual Plan',
      paidAt: new Date('2026-09-10T12:00:00Z'),
      createdAt: new Date('2026-09-10T11:59:00Z'),
      metadata: { card_last4: '4242' },
      invoiceNumber: 'INV-2026-002',
      subscriptionPlan: 'ENTERPRISE',
      billingPeriodStart: null,
      billingPeriodEnd: null,
    };

    (paymentService.getPaymentById as any).mockResolvedValue(mockPayment);

    const validCuid = 'cjld2cjxh0000qzrmn831i7rn';
    const caller = paymentRouter.createCaller(mockCtx);
    const result = await caller.getById({ id: validCuid });

    expect(paymentService.getPaymentById).toHaveBeenCalledWith(
      validCuid,
      testOrgId
    );
    expect(result.id).toBe(mockPayment.id);
    expect(result.currency).toBe('USD');
  });

  it('fetches invoice detail using ctx.tenantPrisma and joins organization data', async () => {
    const mockDetail = {
      id: 'pay_detail_1',
      invoiceNumber: 'INV-2026-003',
      amount: 15000,
      currency: 'KES',
      status: PaymentStatus.COMPLETED,
      provider: PaymentProvider.MPESA,
      providerTransactionId: 'MPESA_987',
      paidAt: new Date('2026-09-15T08:30:00Z'),
      createdAt: new Date('2026-09-15T08:29:00Z'),
      subscriptionPlan: 'PRO',
      billingPeriodStart: new Date('2026-09-15T00:00:00Z'),
      billingPeriodEnd: new Date('2026-10-15T00:00:00Z'),
      metadata: { phone_number: '254700000000' },
      org: {
        name: 'Acme Regulatory Inc',
        address: 'Nairobi, Kenya',
        contactEmail: 'billing@acme.com',
      },
    };

    mockTenantPrisma.payment.findFirst.mockResolvedValue(mockDetail);

    const caller = paymentRouter.createCaller(mockCtx);
    const result = await caller.getDetail({ paymentId: 'pay_detail_1' });

    expect(mockTenantPrisma.payment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pay_detail_1', orgId: testOrgId },
      })
    );
    expect(result.id).toBe('pay_detail_1');
    expect(result.paymentMethodDisplay).toContain('M-Pesa');
    expect(result.user.fullName).toBe('Jane Doe');
    expect(result.organization.name).toBe('Acme Regulatory Inc');
  });
});

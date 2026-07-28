import { describe, expect, it, vi } from 'vitest';
import { appConfig } from '@/config/app.config';
import { ContentOpsAlertService, type SendEmail } from './content-ops-alert.service';

describe('ContentOpsAlertService', () => {
  it('sends via sendEmail to the fixed admin notification address with content_ops_alert tags', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({
      subject: 'High Priority Blog Suggestion',
      summary: 'A high-priority suggestion was auto-approved and drafted.',
      details: ['Suggestion: sug_1'],
      link: 'https://app.sheriabot.com/admin/content/blog/post_1',
    });

    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: appConfig.marketing.adminNotificationEmail,
      subject: 'High Priority Blog Suggestion',
      tags: [
        { name: 'category', value: 'content' },
        { name: 'type', value: 'content_ops_alert' },
      ],
    }));
  });

  it('does not send to a per-entity/per-monitor address - the recipient is always the fixed config value regardless of input', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({ subject: 'x', summary: 'y' });
    await service.sendAlert({ subject: 'x', summary: 'y', details: ['irrelevant'] });

    const recipients = sendEmail.mock.calls.map((call) => call[0].to);
    expect(new Set(recipients)).toEqual(new Set([appConfig.marketing.adminNotificationEmail]));
  });

  it('logs and does not throw when sendEmail fails - an alert failure must never fail the calling automation flow', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('resend unavailable'));
    const service = new ContentOpsAlertService({ sendEmail });

    await expect(service.sendAlert({ subject: 'x', summary: 'y' })).resolves.toBeUndefined();
  });

  it('omits the details list and link when not provided', async () => {
    const sendEmail = vi.fn().mockResolvedValue({ id: 'email-1' });
    const service = new ContentOpsAlertService({ sendEmail });

    await service.sendAlert({ subject: 'x', summary: 'y' });

    const call = sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain('<ul>');
    expect(call.html).not.toContain('<a href');
  });
});

describe('ContentOpsAlertService.createOrIncrementAlert (Pack 1 Stage C4)', () => {
  const NOW = new Date('2026-07-27T12:00:00.000Z');

  function fakeAlertRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'alert_1',
      type: 'verification_blocked',
      severity: 'HIGH',
      status: 'OPEN',
      title: 'Verification blocked',
      summary: 'Blocking issues found.',
      workflowKey: null,
      executionId: null,
      entityType: 'BlogPost',
      entityId: 'post_1',
      occurrenceCount: 1,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      notificationStatus: 'NOT_REQUIRED',
      notificationAttempts: 0,
      lastNotificationAt: null,
      acknowledgedById: null,
      acknowledgedAt: null,
      resolvedById: null,
      resolvedAt: null,
      resolutionNote: null,
      metadata: {},
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  function buildService(overrides: {
    queryRawResult?: Record<string, unknown>;
    updateResult?: Record<string, unknown>;
    sendEmail?: ReturnType<typeof vi.fn<SendEmail>>;
  } = {}) {
    const queryRaw = vi.fn().mockResolvedValue([overrides.queryRawResult ?? fakeAlertRow()]);
    const update = vi.fn().mockResolvedValue(overrides.updateResult ?? fakeAlertRow());
    const findMany = vi.fn();
    const count = vi.fn();
    const findUnique = vi.fn();
    const sendEmail = overrides.sendEmail ?? vi.fn<SendEmail>().mockResolvedValue({ success: true, messageId: 'email-1' });

    const prisma = {
      $queryRaw: queryRaw,
      contentOpsAlert: { update, findMany, count, findUnique },
    };

    const service = new ContentOpsAlertService({ prisma: prisma as never, sendEmail, now: () => NOW });
    return { service, queryRaw, update, findMany, count, findUnique, sendEmail };
  }

  it('persists a first-occurrence HIGH-severity alert and sends a notification (cooldown never elapsed before)', async () => {
    const { service, queryRaw, update, sendEmail } = buildService({
      updateResult: fakeAlertRow({ notificationStatus: 'SENT', notificationAttempts: 1, lastNotificationAt: NOW }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'verification_blocked',
      severity: 'HIGH',
      entityType: 'BlogPost',
      entityId: 'post_1',
      title: 'Verification blocked',
      summary: 'Blocking issues found.',
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'alert_1' },
      data: { notificationStatus: 'SENT', notificationAttempts: { increment: 1 }, lastNotificationAt: NOW },
    });
    expect(result.notificationStatus).toBe('SENT');
  });

  it('the atomic upsert targets the (type, entityType, entityId, COALESCE(workflowKey, \'\')) expression index', async () => {
    const { service, queryRaw } = buildService();

    await service.createOrIncrementAlert({
      type: 'research_pack_gap_detected',
      severity: 'INFO',
      entityType: 'BlogResearchPack',
      entityId: 'pack_1',
      title: 't',
      summary: 's',
    });

    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join('?');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('COALESCE("workflowKey"');
    expect(sql).not.toContain('find'); // sanity: never a find-then-create comment/marker
  });

  it('increments occurrenceCount and updates lastSeenAt while preserving firstSeenAt on a duplicate occurrence', async () => {
    const firstSeen = new Date('2026-07-20T00:00:00.000Z');
    const { service } = buildService({
      queryRawResult: fakeAlertRow({ occurrenceCount: 4, firstSeenAt: firstSeen, lastSeenAt: NOW, severity: 'LOW', notificationStatus: 'NOT_REQUIRED' }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'x', severity: 'LOW', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(result.occurrenceCount).toBe(4);
    expect(result.firstSeenAt).toBe(firstSeen);
    expect(result.lastSeenAt).toBe(NOW);
  });

  it('does not attempt notification for a non-HIGH/CRITICAL severity - notificationStatus stays NOT_REQUIRED', async () => {
    const { service, sendEmail, update } = buildService({
      queryRawResult: fakeAlertRow({ severity: 'MEDIUM', notificationStatus: 'NOT_REQUIRED' }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'x', severity: 'MEDIUM', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(result.notificationStatus).toBe('NOT_REQUIRED');
  });

  it('suppresses (does not email) a HIGH/CRITICAL alert re-occurring inside the cooldown window', async () => {
    const recentNotification = new Date(NOW.getTime() - 60 * 60 * 1000); // 1h ago, well inside 12h cooldown
    const { service, sendEmail, update } = buildService({
      queryRawResult: fakeAlertRow({ severity: 'CRITICAL', lastNotificationAt: recentNotification, notificationStatus: 'SENT' }),
      updateResult: fakeAlertRow({ severity: 'CRITICAL', notificationStatus: 'SUPPRESSED' }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'x', severity: 'CRITICAL', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ where: { id: 'alert_1' }, data: { notificationStatus: 'SUPPRESSED' } });
    expect(result.notificationStatus).toBe('SUPPRESSED');
  });

  it('notifies again once the cooldown has elapsed', async () => {
    const oldNotification = new Date(NOW.getTime() - 13 * 60 * 60 * 1000); // 13h ago, past the 12h cooldown
    const { service, sendEmail } = buildService({
      queryRawResult: fakeAlertRow({ severity: 'HIGH', lastNotificationAt: oldNotification, notificationStatus: 'SENT' }),
    });

    await service.createOrIncrementAlert({
      type: 'x', severity: 'HIGH', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('SUPPRESSED notification status does not imply IGNORED alert status - they are independent axes', async () => {
    const recentNotification = new Date(NOW.getTime() - 60 * 1000);
    const { service } = buildService({
      queryRawResult: fakeAlertRow({ severity: 'HIGH', status: 'OPEN', lastNotificationAt: recentNotification }),
      updateResult: fakeAlertRow({ severity: 'HIGH', status: 'OPEN', notificationStatus: 'SUPPRESSED' }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'x', severity: 'HIGH', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(result.notificationStatus).toBe('SUPPRESSED');
    expect(result.status).toBe('OPEN');
  });

  it('persists the alert even when the notification email fails', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('resend unavailable'));
    const { service, queryRaw, update } = buildService({
      sendEmail,
      updateResult: fakeAlertRow({ notificationStatus: 'FAILED', notificationAttempts: 1 }),
    });

    const result = await service.createOrIncrementAlert({
      type: 'x', severity: 'CRITICAL', entityType: 'BlogPost', entityId: 'post_1', title: 't', summary: 's',
    });

    expect(queryRaw).toHaveBeenCalledTimes(1); // persistence happened
    expect(update).toHaveBeenCalledWith({
      where: { id: 'alert_1' },
      data: { notificationStatus: 'FAILED', notificationAttempts: { increment: 1 }, lastNotificationAt: NOW },
    });
    expect(result.notificationStatus).toBe('FAILED');
  });

  it('sanitizes metadata before persisting - forbidden keys never reach the query', async () => {
    const { service, queryRaw } = buildService();

    await service.createOrIncrementAlert({
      type: 'x',
      severity: 'INFO',
      entityType: 'BlogPost',
      entityId: 'post_1',
      title: 't',
      summary: 's',
      metadata: { suggestionId: 'sug_1', apiToken: 'sb_agent_secret' },
    });

    const [, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const metadataJson = values.find((v) => typeof v === 'string' && v.includes('suggestionId')) as string;
    expect(metadataJson).toContain('sug_1');
    expect(metadataJson).not.toContain('apiToken');
    expect(metadataJson).not.toContain('sb_agent_secret');
  });
});

describe('ContentOpsAlertService.acknowledgeAlert / resolveAlert / listOpenAlerts / getAlert', () => {
  const NOW = new Date('2026-07-27T12:00:00.000Z');

  function buildService() {
    const update = vi.fn().mockResolvedValue({ id: 'alert_1' });
    const findMany = vi.fn().mockResolvedValue([{ id: 'alert_1' }]);
    const count = vi.fn().mockResolvedValue(1);
    const findUnique = vi.fn().mockResolvedValue({ id: 'alert_1' });
    const prisma = { $queryRaw: vi.fn(), contentOpsAlert: { update, findMany, count, findUnique } };
    const service = new ContentOpsAlertService({ prisma: prisma as never, now: () => NOW });
    return { service, update, findMany, count, findUnique };
  }

  it('acknowledgeAlert sets status/acknowledgedById/acknowledgedAt, derived from a server-side actor id', async () => {
    const { service, update } = buildService();
    await service.acknowledgeAlert({ alertId: 'alert_1', by: 'user_1' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'alert_1' },
      data: { status: 'ACKNOWLEDGED', acknowledgedById: 'user_1', acknowledgedAt: NOW },
    });
  });

  it('resolveAlert sets status/resolvedById/resolvedAt and sanitizes an optional resolutionNote', async () => {
    const { service, update } = buildService();
    await service.resolveAlert({ alertId: 'alert_1', by: 'user_1', resolutionNote: '<b>fixed it</b>' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'alert_1' },
      data: { status: 'RESOLVED', resolvedById: 'user_1', resolvedAt: NOW, resolutionNote: 'fixed it' },
    });
  });

  it('resolveAlert omits resolutionNote from the update entirely when not provided (does not clear an existing note)', async () => {
    const { service, update } = buildService();
    await service.resolveAlert({ alertId: 'alert_1', by: 'user_1' });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'alert_1' },
      data: { status: 'RESOLVED', resolvedById: 'user_1', resolvedAt: NOW },
    });
  });

  it('listOpenAlerts filters to OPEN/ACKNOWLEDGED by default and supports severity/type/entityType filters', async () => {
    const { service, findMany, count } = buildService();
    await service.listOpenAlerts({ severity: 'HIGH', type: 'verification_blocked', entityType: 'BlogPost' });
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] }, severity: 'HIGH', type: 'verification_blocked', entityType: 'BlogPost' },
    }));
    expect(count).toHaveBeenCalled();
  });

  it('getAlert reads a single alert by id', async () => {
    const { service, findUnique } = buildService();
    await service.getAlert('alert_1');
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'alert_1' } });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('email theme logo URLs', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('builds logo URLs starting with public bucketUrl when configured', async () => {
    vi.doMock('@/config/app.config', () => ({
      appConfig: {
        publicStorage: {
          bucketUrl: 'https://test.r2.dev',
        },
      },
    }));

    const warnSpy = vi.fn();
    vi.doMock('@/utils/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const { LOGO_URL, EMAIL_SIGNATURE_LOGO_URL } = await import('../theme');

    expect(LOGO_URL.startsWith('https://test.r2.dev/')).toBe(true);
    expect(EMAIL_SIGNATURE_LOGO_URL.startsWith('https://test.r2.dev/')).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('loads without throwing when bucketUrl is empty', async () => {
    vi.doMock('@/config/app.config', () => ({
      appConfig: {
        publicStorage: {
          bucketUrl: '',
        },
      },
    }));

    const warnSpy = vi.fn();
    vi.doMock('@/utils/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    const theme = await import('../theme');
    expect(theme).toBeDefined();
    expect(theme.LOGO_URL).toBe('/branding/Sheriabot%20logo%20-%20email.png');
  });

  it('logs a warning exactly once when bucketUrl is empty', async () => {
    vi.doMock('@/config/app.config', () => ({
      appConfig: {
        publicStorage: {
          bucketUrl: '',
        },
      },
    }));

    const warnSpy = vi.fn();
    vi.doMock('@/utils/logger', () => ({
      logger: {
        warn: warnSpy,
        info: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    }));

    await import('../theme');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith({ type: 'email_theme_public_url_missing' });
  });
});

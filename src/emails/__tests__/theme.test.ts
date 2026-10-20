import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  bucketUrl: '',
  warn: vi.fn(),
}));

vi.mock('@/config/app.config', () => ({
  appConfig: {
    publicStorage: {
      get bucketUrl() {
        return mocks.bucketUrl;
      },
    },
  },
}));

vi.mock('@/utils/logger', () => ({
  logger: {
    warn: mocks.warn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('email theme logo URLs', () => {
  const originalPublicBucketUrl = process.env.R2_PUBLIC_BUCKET_URL;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.bucketUrl = '';
    delete process.env.R2_PUBLIC_BUCKET_URL;
  });

  afterEach(() => {
    if (originalPublicBucketUrl === undefined) delete process.env.R2_PUBLIC_BUCKET_URL;
    else process.env.R2_PUBLIC_BUCKET_URL = originalPublicBucketUrl;
  });

  it('builds logo URLs starting with public bucketUrl when configured', async () => {
    mocks.bucketUrl = 'https://test.r2.dev';

    const { LOGO_URL, EMAIL_SIGNATURE_LOGO_URL } = await import('../theme');

    expect(LOGO_URL.startsWith('https://test.r2.dev/')).toBe(true);
    expect(EMAIL_SIGNATURE_LOGO_URL.startsWith('https://test.r2.dev/')).toBe(true);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('loads without throwing when bucketUrl is empty', async () => {
    const theme = await import('../theme');
    expect(theme).toBeDefined();
    expect(theme.LOGO_URL.startsWith('https://')).toBe(true);
    expect(theme.LOGO_URL).toBe('https://pub-724936356a15494f9ce61480c5225e6f.r2.dev/branding/Sheriabot%20logo%20-%20email.png');
  });

  it('logs a warning exactly once when bucketUrl is empty', async () => {
    await import('../theme');

    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledWith({ type: 'email_theme_public_url_missing' });
  });
});

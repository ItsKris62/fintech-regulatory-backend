import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

describe('F-04: Fastify Inbound Timeouts (audit REL-04)', () => {
  const appSource = readFileSync(resolve(__dirname, '../app.ts'), 'utf8');
  const complianceStreamSource = readFileSync(
    resolve(__dirname, '../routes/compliance-stream.route.ts'),
    'utf8'
  );

  it('configures global inbound timeouts on Fastify initialization', () => {
    expect(appSource).toContain('connectionTimeout: 30000');
    expect(appSource).toContain('requestTimeout: 60000');
    expect(appSource).toContain('keepAliveTimeout: 5000');
    expect(appSource).toContain('pluginTimeout: 15000');
  });

  it('overrides requestTimeout at route level for SSE streams to prevent disconnects', () => {
    // /api/alerts/stream
    expect(appSource).toContain('/api/alerts/stream');
    expect(appSource).toMatch(/'\/api\/alerts\/stream'[\s\S]*?requestTimeout:\s*0/);

    // /api/compliance/stream
    expect(complianceStreamSource).toContain('/api/compliance/stream');
    expect(complianceStreamSource).toMatch(/'\/api\/compliance\/stream'[\s\S]*?requestTimeout:\s*0/);
  });

  it('successfully initializes Fastify with the configured timeout options', async () => {
    const app = Fastify({
      connectionTimeout: 30000,
      requestTimeout: 60000,
      keepAliveTimeout: 5000,
      pluginTimeout: 15000,
    });

    app.get('/test-stream', { requestTimeout: 0 }, async () => ({ status: 'streaming' }));
    await app.ready();

    expect(app.server.timeout).toBe(30000); // Node HTTP server connection timeout
    expect(app.server.keepAliveTimeout).toBe(5000);

    await app.close();
  }, 15000);
});

import { describe, expect, it } from 'bun:test';
import { POST } from './id';
import { config } from '../../../lib/server/config';

describe('ID Webhook Security Endpoint', () => {
  it('fails closed with 503 if WEBHOOK_SECRET is not configured', async () => {
    // If webhook secret is empty
    const orig = (config as any).webhookSecret;
    Object.defineProperty(config, 'webhookSecret', {
      value: '',
      configurable: true,
    });

    try {
      const req = new Request('http://localhost:4321/api/webhooks/id', {
        method: 'POST',
        headers: { 'x-webhook-secret': 'some-random-secret' },
      });

      const res = await POST({ request: req } as any);
      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error).toBe('webhook_not_configured');
    } finally {
      Object.defineProperty(config, 'webhookSecret', {
        value: orig,
        configurable: true,
      });
    }
  });

  it('rejects unauthorized requests with 401 using constant-time comparison', async () => {
    Object.defineProperty(config, 'webhookSecret', {
      value: 'correct-super-secret-key-12345',
      configurable: true,
    });

    const req = new Request('http://localhost:4321/api/webhooks/id', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong-secret' },
    });

    const res = await POST({ request: req } as any);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('unauthorized');
  });

  it('accepts authorized requests with 200 and invalidates cache', async () => {
    Object.defineProperty(config, 'webhookSecret', {
      value: 'correct-super-secret-key-12345',
      configurable: true,
    });

    const req = new Request('http://localhost:4321/api/webhooks/id', {
      method: 'POST',
      headers: {
        'x-webhook-secret': 'correct-super-secret-key-12345',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event: 'user.updated' }),
    });

    const res = await POST({ request: req } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.invalidated).toBe(true);
  });
});

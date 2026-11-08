import { describe, expect, it, beforeAll } from 'bun:test';
import { GET, POST } from '../../src/pages/api/profile';
import { getDirectorySnapshot } from '../../src/lib/server/id-directory';

describe('/api/profile endpoint', () => {
  let activeSub = '';

  beforeAll(async () => {
    const snapshot = await getDirectorySnapshot();
    activeSub = snapshot.members[0]?.sub || '01a1a7a2-31ea-7610-9e1d-be737abbeb97';
  });

  it('returns 401 when no session is present for GET', async () => {
    const res = await GET({
      locals: { user: null },
    } as any);

    expect(res.status).toBe(401);
  });

  it('returns 401 when no session is present for POST', async () => {
    const request = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ headline: 'Hello' }),
    });

    const res = await POST({
      request,
      locals: { user: null },
      url: new URL('http://localhost:4321/api/profile'),
    } as any);

    expect(res.status).toBe(401);
  });

  it('returns 422 with field errors on invalid data', async () => {
    const request = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headline: 'A'.repeat(200), // Exceeds limit
        websiteUrl: 'javascript:alert(1)',
      }),
    });

    const res = await POST({
      request,
      locals: {
        user: {
          sub: activeSub,
          preferred_username: 'testuser',
        },
      },
      url: new URL('http://localhost:4321/api/profile'),
    } as any);

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('Validation failed');
    expect(body.fieldErrors.headline).toBeDefined();
    expect(body.fieldErrors.websiteUrl).toBeDefined();
  });

  it('saves valid profile and returns 200', async () => {
    const request = new Request('http://localhost:4321/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        headline: 'Systems Engineer',
        major: 'Computer Science',
        location: 'West Lafayette, IN',
        websiteUrl: 'https://purduehackers.com',
        socials: {
          github: 'purduehackers',
        },
      }),
    });

    const res = await POST({
      request,
      locals: {
        user: {
          sub: activeSub,
          preferred_username: 'testapi',
        },
      },
      url: new URL('http://localhost:4321/api/profile'),
    } as any);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.profile.headline).toBe('Systems Engineer');
    expect(body.profile.major).toBe('Computer Science');
    expect(body.profile.location).toBe('West Lafayette, IN');
    expect(body.profile.socials.github).toBe('https://github.com/purduehackers');
  });
});

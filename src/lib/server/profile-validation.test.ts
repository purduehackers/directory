import { describe, expect, it } from 'bun:test';
import {
  cleanSingleLine,
  cleanMultiLine,
  normalizeSocialLink,
  sanitizeHttpUrl,
  isValidIanaTimezone,
  validateProfileInput,
} from './profile-validation';

describe('profile-validation', () => {
  describe('cleanSingleLine & cleanMultiLine', () => {
    it('strips BiDi overrides and zero-width spaces', () => {
      const bidi = 'Test\u202Ereversed\u200Bzero';
      const cleaned = cleanSingleLine(bidi);
      expect(cleaned).toBe('Test reversed zero');
    });
  });

  describe('sanitizeHttpUrl', () => {
    it('allows valid https URLs', () => {
      const res = sanitizeHttpUrl('https://purduehackers.com/about');
      expect(res.error).toBeUndefined();
      expect(res.url).toBe('https://purduehackers.com/about');
    });

    it('auto-prefixes bare domain with https', () => {
      const res = sanitizeHttpUrl('purduehackers.com');
      expect(res.error).toBeUndefined();
      expect(res.url).toBe('https://purduehackers.com/');
    });

    it('rejects javascript: schemes', () => {
      const res = sanitizeHttpUrl('javascript:alert(1)');
      expect(res.error).toBeDefined();
      expect(res.url).toBeNull();
    });

    it('rejects data: schemes', () => {
      const res = sanitizeHttpUrl('data:text/html,<script>alert(1)</script>');
      expect(res.error).toBeDefined();
      expect(res.url).toBeNull();
    });

    it('rejects URLs with embedded credentials', () => {
      const res = sanitizeHttpUrl('https://admin:secret@evil.com');
      expect(res.error).toBeDefined();
      expect(res.url).toBeNull();
    });
  });

  describe('normalizeSocialLink', () => {
    it('normalizes handles for GitHub', () => {
      const res = normalizeSocialLink('github', '@torvalds');
      expect(res.error).toBeUndefined();
      expect(res.value).toBe('https://github.com/torvalds');
    });

    it('normalizes full URLs for GitHub', () => {
      const res = normalizeSocialLink('github', 'https://github.com/purduehackers');
      expect(res.error).toBeUndefined();
      expect(res.value).toBe('https://github.com/purduehackers');
    });

    it('rejects spoofed domains for GitHub', () => {
      const res = normalizeSocialLink('github', 'https://evil.com/torvalds');
      expect(res.error).toBeDefined();
    });

    it('rejects spoofed domains for LinkedIn', () => {
      const res = normalizeSocialLink('linkedin', 'https://evil-linkedin.com/in/user');
      expect(res.error).toBeDefined();
    });

    it('handles LinkedIn in/username shorthand cleanly', () => {
      const res = normalizeSocialLink('linkedin', 'in/torvalds');
      expect(res.error).toBeUndefined();
      expect(res.value).toBe('https://www.linkedin.com/in/torvalds');
    });

    it('rejects bare Mastodon instance URLs without profile paths', () => {
      const res = normalizeSocialLink('mastodon', 'https://mastodon.social/');
      expect(res.error).toBeDefined();
    });

    it('normalizes Twitter / X handles and URLs', () => {
      const handleRes = normalizeSocialLink('x', 'purduehackers');
      expect(handleRes.value).toBe('https://x.com/purduehackers');

      const urlRes = normalizeSocialLink('x', 'https://twitter.com/purduehackers');
      expect(urlRes.value).toBe('https://twitter.com/purduehackers');
    });

    it('normalizes Bluesky handles', () => {
      const bsky1 = normalizeSocialLink('bluesky', 'alice.bsky.social');
      expect(bsky1.value).toBe('https://bsky.app/profile/alice.bsky.social');

      const bsky2 = normalizeSocialLink('bluesky', 'bob');
      expect(bsky2.value).toBe('https://bsky.app/profile/bob.bsky.social');
    });
  });

  describe('isValidIanaTimezone', () => {
    it('accepts valid timezones', () => {
      expect(isValidIanaTimezone('America/Indiana/Indianapolis')).toBe(true);
      expect(isValidIanaTimezone('America/New_York')).toBe(true);
      expect(isValidIanaTimezone('UTC')).toBe(true);
    });

    it('rejects invalid timezones', () => {
      expect(isValidIanaTimezone('Purdue/Hackers')).toBe(false);
      expect(isValidIanaTimezone('invalid_tz')).toBe(false);
    });
  });

  describe('validateProfileInput', () => {
    it('validates a complete, well-formed profile payload', () => {
      const res = validateProfileInput({
        headline: 'Hacker & Systems Dev',
        bio: 'Hello world!\nExcited to hack.',
        location: 'West Lafayette, IN',
        timezone: 'America/Indiana/Indianapolis',
        websiteUrl: 'https://purduehackers.com',
        socials: {
          github: 'purduehackers',
          x: '@purduehackers',
        },
        customLinks: [
          { label: 'Blog', url: 'https://blog.purduehackers.com' },
        ],
        contactVisibility: {
          emails: {
            'hacker@purdue.edu': true,
            'personal@gmail.com': false,
          },
          phone: false,
        },
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.headline).toBe('Hacker & Systems Dev');
        expect(res.data.location).toBe('West Lafayette, IN');
        expect(res.data.socials.github).toBe('https://github.com/purduehackers');
        expect(res.data.customLinks).toHaveLength(1);
        expect(res.data.contactVisibility.phone).toBe(false);
        expect(res.data.contactVisibility.emails?.['hacker@purdue.edu']).toBe(true);
        expect(res.data.contactVisibility.emails?.['personal@gmail.com']).toBe(false);
      }
    });

    it('defaults contactVisibility cleanly when omitted', () => {
      const res = validateProfileInput({
        headline: 'Simple profile',
      });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.data.contactVisibility.phone).toBe(false);
        expect(res.data.contactVisibility.emails).toEqual({});
      }
    });

    it('enforces character limits', () => {
      const res = validateProfileInput({
        headline: 'A'.repeat(150), // limit is 100
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.errors.headline).toBeDefined();
      }
    });
  });
});

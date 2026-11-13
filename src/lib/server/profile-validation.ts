import type { ContactVisibility, CustomLink, SocialLinks, TimeFormat } from './db/schema';
import { config } from './config';

export type ProfileInputPayload = {
  headline?: unknown;
  major?: unknown;
  bio?: unknown;
  location?: unknown;
  timezone?: unknown;
  timeFormat?: unknown;
  websiteUrl?: unknown;
  socials?: Record<string, unknown> | unknown;
  customLinks?: unknown;
  contactVisibility?: unknown;
};

export type ValidatedProfileData = {
  headline: string | null;
  major: string | null;
  bio: string | null;
  location: string | null;
  timezone: string | null;
  timeFormat?: TimeFormat;
  websiteUrl: string | null;
  socials: SocialLinks;
  customLinks: CustomLink[];
  contactVisibility: ContactVisibility;
};

export type ProfileValidationResult =
  | { ok: true; data: ValidatedProfileData }
  | { ok: false; errors: Record<string, string> };

// C0 controls, DEL, zero-width spaces, and BiDi override characters
const DANGEROUS_UNICODE_SINGLE = /[\x00-\x1F\x7F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const DANGEROUS_UNICODE_MULTI = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g;
const EXCESSIVE_COMBINING_MARKS = /(\p{M}{3})\p{M}+/gu;

export const PROFILE_LIMITS = {
  headline: 100,
  major: 80,
  bio: 600,
  location: 80,
  websiteUrl: 512,
  socialInput: 512,
  customLinkLabel: 40,
  customLinksCount: 5,
} as const;

export function cleanSingleLine(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val
    .normalize('NFC')
    .replace(DANGEROUS_UNICODE_SINGLE, ' ')
    .replace(EXCESSIVE_COMBINING_MARKS, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanMultiLine(val: unknown): string {
  if (typeof val !== 'string') return '';
  return val
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(DANGEROUS_UNICODE_MULTI, '')
    .replace(EXCESSIVE_COMBINING_MARKS, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeHttpUrl(raw: unknown, allowLocalhost = false): { url: string | null; error?: string } {
  const cleaned = cleanSingleLine(raw);
  if (!cleaned) return { url: null };

  if (cleaned.length > PROFILE_LIMITS.websiteUrl) {
    return { url: null, error: `URL must be ${PROFILE_LIMITS.websiteUrl} characters or fewer.` };
  }

  // Reject dangerous schemes explicitly before auto-prefixing
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(cleaned) && !/^https?:\/\//i.test(cleaned)) {
    return { url: null, error: 'Only http:// and https:// URLs are allowed.' };
  }

  const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { url: null, error: 'Only http:// and https:// URLs are allowed.' };
    }
    const host = parsed.hostname.toLowerCase();
    const isLocalOrPrivate =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('[') ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
      /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host);

    if (isLocalOrPrivate && !allowLocalhost) {
      return { url: null, error: 'Local or internal network URLs are not allowed in public profiles.' };
    }

    if (!isLocalOrPrivate && (!host.includes('.') || host.endsWith('.'))) {
      return { url: null, error: 'Please enter a valid domain name.' };
    }
    if (parsed.username || parsed.password) {
      return { url: null, error: 'URLs cannot contain embedded credentials.' };
    }
    return { url: parsed.toString() };
  } catch {
    return { url: null, error: 'Please enter a valid URL.' };
  }
}

export type SocialPlatform = keyof SocialLinks;
const HANDLE_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

export function normalizeSocialLink(
  platform: SocialPlatform,
  raw: unknown
): { value: string | undefined; error?: string } {
  const cleaned = cleanSingleLine(raw);
  if (!cleaned) return { value: undefined };

  if (cleaned.length > PROFILE_LIMITS.socialInput) {
    return { value: undefined, error: `Input exceeds maximum length of ${PROFILE_LIMITS.socialInput} characters.` };
  }

  // Special-case: handle LinkedIn 'in/username' shorthand without treating 'in' as a domain
  let adjusted = cleaned;
  if (platform === 'linkedin' && /^in\/[a-zA-Z0-9._-]+$/i.test(adjusted)) {
    adjusted = adjusted.replace(/^in\//i, '');
  }

  // Check if user pasted a full URL
  if (/^https?:\/\//i.test(adjusted) || adjusted.includes('/')) {
    const { url, error } = sanitizeHttpUrl(adjusted);
    if (error || !url) return { value: undefined, error: `Invalid ${platform} URL.` };
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    switch (platform) {
      case 'github':
        if (host !== 'github.com') return { value: undefined, error: 'Must be a github.com link or username.' };
        break;
      case 'x':
        if (host !== 'x.com' && host !== 'twitter.com') {
          return { value: undefined, error: 'Must be an x.com or twitter.com link or handle.' };
        }
        break;
      case 'linkedin':
        if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) {
          return { value: undefined, error: 'Must be a linkedin.com profile link or handle.' };
        }
        break;
      case 'instagram':
        if (host !== 'instagram.com') {
          return { value: undefined, error: 'Must be an instagram.com link or handle.' };
        }
        break;
      case 'youtube':
        if (host !== 'youtube.com' && host !== 'youtu.be') {
          return { value: undefined, error: 'Must be a youtube.com link or @handle.' };
        }
        break;
      case 'bluesky':
        if (host !== 'bsky.app') return { value: undefined, error: 'Must be a bsky.app profile link or handle.' };
        break;
      case 'mastodon':
        // Mastodon profile path must reference a valid user profile (@username or users/username)
        if (!/^\/(@[a-zA-Z0-9_]+|users\/[a-zA-Z0-9_]+)\/?$/i.test(parsed.pathname)) {
          return { value: undefined, error: 'Please enter a valid Mastodon profile URL (e.g. https://instance.org/@user).' };
        }
        return { value: `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}` };
    }

    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.length === 0) {
      return { value: undefined, error: `Please include your ${platform} username in the URL.` };
    }
    // Clean URL without search query or hash
    return { value: `${parsed.origin}${parsed.pathname}` };
  }

  // Handle format
  const stripped = adjusted.replace(/^@/, '');
  if (platform === 'bluesky') {
    const handleCandidate = stripped.includes('.') ? stripped : `${stripped}.bsky.social`;
    if (!/^[a-zA-Z0-9.-]{3,100}$/.test(handleCandidate)) {
      return { value: undefined, error: 'Invalid Bluesky handle.' };
    }
    return { value: `https://bsky.app/profile/${handleCandidate}` };
  }

  if (platform === 'mastodon') {
    const mastodonMatch = stripped.match(/^([a-zA-Z0-9_]+)@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/);
    if (!mastodonMatch) {
      return {
        value: undefined,
        error: 'Enter a full Mastodon URL or handle like @user@fosstodon.org.',
      };
    }
    return { value: `https://${mastodonMatch[2]}/@${mastodonMatch[1]}` };
  }

  if (!HANDLE_REGEX.test(stripped)) {
    return { value: undefined, error: `Invalid ${platform} username.` };
  }

  switch (platform) {
    case 'github':
      return { value: `https://github.com/${stripped}` };
    case 'x':
      return { value: `https://x.com/${stripped}` };
    case 'linkedin':
      return { value: `https://www.linkedin.com/in/${stripped}` };
    case 'instagram':
      return { value: `https://www.instagram.com/${stripped}` };
    case 'youtube':
      return { value: `https://www.youtube.com/@${stripped}` };
  }
}

export function formatSocialLabel(
  platform: SocialPlatform | 'website',
  urlOrInput: string
): string {
  const cleaned = cleanSingleLine(urlOrInput);
  if (!cleaned) return '';

  if (platform === 'website') {
    try {
      const candidate = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;
      const parsed = new URL(candidate);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
      const path = parsed.pathname.replace(/\/+$/, '');
      return path && path !== '/' ? `${host}${path}` : host;
    } catch {
      return 'Website';
    }
  }

  const normalized = normalizeSocialLink(platform, cleaned).value ?? cleaned;
  try {
    const parsed = new URL(normalized);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    switch (platform) {
      case 'github': {
        const handle = (segments[0] || '').replace(/^@/, '');
        return handle || cleaned;
      }
      case 'x':
      case 'instagram': {
        const handle = (segments[0] || '').replace(/^@/, '');
        return handle ? `@${handle}` : cleaned;
      }
      case 'youtube': {
        const last = segments[segments.length - 1] || '';
        if (!last) return cleaned;
        return last.startsWith('@') ? last : `@${last}`;
      }
      case 'linkedin': {
        if (segments[0]?.toLowerCase() === 'in' && segments[1]) {
          return `in/${segments[1]}`;
        }
        return segments.length > 0 ? segments.join('/') : cleaned;
      }
      case 'bluesky': {
        const last = (segments[segments.length - 1] || '').replace(/^@/, '');
        return last ? `@${last}` : cleaned;
      }
      case 'mastodon': {
        const rawUser =
          segments[0]?.toLowerCase() === 'users' && segments[1]
            ? segments[1]
            : segments[0] || '';
        const user = rawUser.replace(/^@/, '');
        return user ? `@${user}@${host}` : cleaned;
      }
    }
  } catch {
    return cleaned;
  }
}

export function canonicalizeIanaTimezone(tz: string): string | null {
  try {
    return Intl.DateTimeFormat(undefined, { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function isValidIanaTimezone(tz: string): boolean {
  return canonicalizeIanaTimezone(tz) !== null;
}

export function validateProfileInput(input: ProfileInputPayload): ProfileValidationResult {
  const errors: Record<string, string> = {};

  // 1. Headline
  const headline = cleanSingleLine(input.headline);
  if (headline.length > PROFILE_LIMITS.headline) {
    errors.headline = `Headline must be ${PROFILE_LIMITS.headline} characters or fewer.`;
  }

  // 1b. Major
  const major = cleanSingleLine(input.major);
  if (major.length > PROFILE_LIMITS.major) {
    errors.major = `Major must be ${PROFILE_LIMITS.major} characters or fewer.`;
  }

  // 2. Bio
  const bio = cleanMultiLine(input.bio);
  if (bio.length > PROFILE_LIMITS.bio) {
    errors.bio = `Bio must be ${PROFILE_LIMITS.bio} characters or fewer.`;
  }

  // 3. Location
  const location = cleanSingleLine(input.location);
  if (location.length > PROFILE_LIMITS.location) {
    errors.location = `Location must be ${PROFILE_LIMITS.location} characters or fewer.`;
  }

  // 4. Timezone & Time Format
  const rawTz = cleanSingleLine(input.timezone);
  let timezone: string | null = null;
  if (rawTz) {
    timezone = canonicalizeIanaTimezone(rawTz);
    if (!timezone) {
      errors.timezone = 'Invalid IANA timezone identifier.';
    }
  }

  const rawTimeFormat = cleanSingleLine(input.timeFormat).toLowerCase();
  let timeFormat: TimeFormat = '12h';
  if (rawTimeFormat) {
    if (rawTimeFormat === '12h' || rawTimeFormat === '12') {
      timeFormat = '12h';
    } else if (rawTimeFormat === '24h' || rawTimeFormat === '24') {
      timeFormat = '24h';
    } else {
      errors.timeFormat = 'Time format must be 12h or 24h.';
    }
  }

  // 5. Website URL
  const websiteResult = sanitizeHttpUrl(input.websiteUrl);
  if (websiteResult.error) {
    errors.websiteUrl = websiteResult.error;
  }

  // 6. Social Links
  const socials: SocialLinks = {};
  const rawSocials =
    input.socials && typeof input.socials === 'object'
      ? (input.socials as Record<string, unknown>)
      : {};
  const platforms: SocialPlatform[] = [
    'github',
    'x',
    'linkedin',
    'instagram',
    'youtube',
    'bluesky',
    'mastodon',
  ];
  for (const platform of platforms) {
    const res = normalizeSocialLink(platform, rawSocials[platform]);
    if (res.error) {
      errors[`socials.${platform}`] = res.error;
    } else if (res.value) {
      socials[platform] = res.value;
    }
  }

  // 7. Custom Links
  const customLinks: CustomLink[] = [];
  if (Array.isArray(input.customLinks)) {
    if (input.customLinks.length > PROFILE_LIMITS.customLinksCount) {
      errors.customLinks = `You can add at most ${PROFILE_LIMITS.customLinksCount} custom links.`;
    } else {
      input.customLinks.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const label = cleanSingleLine((item as Record<string, unknown>).label);
        const rawUrl = cleanSingleLine((item as Record<string, unknown>).url);
        if (!label && !rawUrl) return; // Ignore blank rows
        if (!label) {
          errors[`customLinks.${idx}.label`] = 'Link title is required.';
          return;
        }
        if (label.length > PROFILE_LIMITS.customLinkLabel) {
          errors[`customLinks.${idx}.label`] = `Title must be ${PROFILE_LIMITS.customLinkLabel} chars or fewer.`;
          return;
        }
        const urlCheck = sanitizeHttpUrl(rawUrl);
        if (urlCheck.error || !urlCheck.url) {
          errors[`customLinks.${idx}.url`] = urlCheck.error || 'Valid URL is required.';
          return;
        }
        customLinks.push({ label, url: urlCheck.url });
      });
    }
  }

  // 8. Contact Visibility
  const contactVisibility: ContactVisibility = {
    emails: {},
    phone: false,
  };
  if (input.contactVisibility && typeof input.contactVisibility === 'object') {
    const rawCv = input.contactVisibility as Record<string, unknown>;
    if (typeof rawCv.phone === 'boolean') {
      contactVisibility.phone = rawCv.phone;
    }
    if (rawCv.emails && typeof rawCv.emails === 'object') {
      const emailMap: Record<string, boolean> = {};
      for (const [em, val] of Object.entries(rawCv.emails as Record<string, unknown>)) {
        const cleanEm = cleanSingleLine(em).toLowerCase();
        if (cleanEm && typeof val === 'boolean') {
          emailMap[cleanEm] = val;
        }
      }
      contactVisibility.emails = emailMap;
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      headline: headline || null,
      major: major || null,
      bio: bio || null,
      location: location || null,
      timezone: timezone || null,
      timeFormat,
      websiteUrl: websiteResult.url,
      socials,
      customLinks,
      contactVisibility,
    },
  };
}

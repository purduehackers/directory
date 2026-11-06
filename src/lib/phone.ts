import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * Formats a raw or stored phone number into standard international format (+1 765 555 0199).
 * Falls back to US country code if no country calling code is provided.
 * If the input cannot be parsed, safely returns the trimmed original input or empty string.
 */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';

  try {
    const parsed =
      parsePhoneNumberFromString(trimmed) ||
      parsePhoneNumberFromString(trimmed, 'US');

    if (parsed) {
      return parsed.formatInternational();
    }
  } catch {
    // Return original trimmed text on unexpected parse error
  }

  return trimmed;
}

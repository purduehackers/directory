import { describe, expect, it } from 'bun:test';
import { formatPhone } from './phone';

describe('Phone Number Formatter', () => {
  it('formats E.164 US phone numbers to international standard with spaces', () => {
    expect(formatPhone('+17655550199')).toBe('+1 765 555 0199');
    expect(formatPhone('+12482839772')).toBe('+1 248 283 9772');
  });

  it('normalizes already punctuated US numbers', () => {
    expect(formatPhone('+1 (765) 555-0199')).toBe('+1 765 555 0199');
    expect(formatPhone('(765) 555-0199')).toBe('+1 765 555 0199');
    expect(formatPhone('765-555-0199')).toBe('+1 765 555 0199');
  });

  it('formats 10-digit raw numbers assuming US country code', () => {
    expect(formatPhone('7655550199')).toBe('+1 765 555 0199');
    expect(formatPhone('17655550199')).toBe('+1 765 555 0199');
  });

  it('formats international numbers correctly', () => {
    expect(formatPhone('+447911123456')).toBe('+44 7911 123456');
    expect(formatPhone('+33123456789')).toBe('+33 1 23 45 67 89');
  });

  it('handles empty, null, undefined and invalid input gracefully', () => {
    expect(formatPhone(null)).toBe('');
    expect(formatPhone(undefined)).toBe('');
    expect(formatPhone('')).toBe('');
    expect(formatPhone('   ')).toBe('');
    expect(formatPhone('invalid-number')).toBe('invalid-number');
  });
});

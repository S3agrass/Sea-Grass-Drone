import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  PASSWORD_RULES,
  describePasswordError,
  validateNewPassword,
} from '../lib/passwordPolicy';

// The password rules are stated on three screens and enforced in two, and the
// thing worth pinning is that those two sets agree. A form that enforces a rule
// it never stated makes people fail twice before they work out why; a form that
// states a rule it does not enforce is worse, because it is simply untrue.

describe('validateNewPassword', () => {
  it('accepts a password that meets every stated rule', () => {
    expect(validateNewPassword('goodpass', 'goodpass')).toBe('');
  });

  it('rejects one shorter than the stated minimum', () => {
    expect(validateNewPassword('abc', 'abc')).toMatch(/at least 6 characters/i);
  });

  it('accepts one exactly at the minimum, not just over it', () => {
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH), 'a'.repeat(MIN_PASSWORD_LENGTH))).toBe('');
  });

  it('rejects a mismatched confirmation', () => {
    expect(validateNewPassword('goodpass', 'goodpazz')).toMatch(/do not match/i);
  });

  it('reports the length problem first, as the one the user can see', () => {
    // Both rules broken. Telling someone their passwords do not match when the
    // real problem is that both are too short sends them to fix the wrong field.
    expect(validateNewPassword('abc', 'xyz')).toMatch(/at least 6 characters/i);
  });
});

describe('PASSWORD_RULES', () => {
  it('states the length rule that validateNewPassword actually enforces', () => {
    expect(PASSWORD_RULES.join(' ')).toMatch(
      new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`, 'i'),
    );
  });

  // Deliberate: Supabase stores only the current password hash and has no
  // password-history feature, so "different from any password you have used
  // before" cannot be enforced without our own table of past hashes. Until that
  // exists the list must not claim it.
  it('claims nothing about passwords older than the current one', () => {
    expect(PASSWORD_RULES.join(' ')).not.toMatch(/previous|used before|history/i);
  });

  it('does state the current-password rule, which Supabase does enforce', () => {
    expect(PASSWORD_RULES.join(' ')).toMatch(/different from your current password/i);
  });
});

describe('describePasswordError', () => {
  it('turns same_password into the rule the page already stated', () => {
    expect(describePasswordError({ code: 'same_password' })).toMatch(
      /already your password/i,
    );
  });

  it('recognises the same rejection by message, not only by code', () => {
    expect(
      describePasswordError({
        message: 'New password should be different from the old password.',
      }),
    ).toMatch(/already your password/i);
  });

  it('restates the length rule when the server is the one to catch it', () => {
    expect(describePasswordError({ code: 'weak_password' })).toMatch(
      /at least 6 characters/i,
    );
  });

  it('passes an unrecognised failure through rather than swallowing it', () => {
    expect(describePasswordError({ message: 'Network unreachable' })).toBe(
      'Network unreachable',
    );
  });

  it('still says something useful when handed nothing at all', () => {
    expect(describePasswordError(undefined)).toMatch(/could not set that password/i);
  });
});

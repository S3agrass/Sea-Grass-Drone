import { describe, it, expect } from 'vitest';
import { readRecoveryParams } from '../lib/auth';

// Where the recovery code actually turns up in the URL.
//
// The redirect we hand Supabase already has a fragment on it — this app hash
// routes, so the target is `/desktop/#/reset-password` — and Supabase then has
// to attach `?code=` to that. Treated as a URL the query lands BEFORE the
// fragment; concatenated as a string it lands after. Only the first leaves
// anything in window.location.search, and which one we get is not ours to
// decide, so both have to work.
//
// Reading only `search` is what made this worth pinning: in the append case the
// page would report "this page needs a recovery link" while holding a perfectly
// good one, which is indistinguishable from an expired link to the person
// staring at it.

const loc = (search, hash) => ({ search, hash });

describe('readRecoveryParams', () => {
  it('finds a code parsed into the query string', () => {
    expect(
      readRecoveryParams(loc('?code=abc123', '#/reset-password')).code,
    ).toBe('abc123');
  });

  it('finds a code appended after the fragment', () => {
    expect(
      readRecoveryParams(loc('', '#/reset-password?code=abc123')).code,
    ).toBe('abc123');
  });

  it('finds a code alongside other params in either position', () => {
    expect(
      readRecoveryParams(loc('?foo=1&code=abc123&bar=2', '#/reset-password')).code,
    ).toBe('abc123');
    expect(
      readRecoveryParams(loc('', '#/reset-password?foo=1&code=abc123')).code,
    ).toBe('abc123');
  });

  it('reports no code when there genuinely is not one', () => {
    expect(readRecoveryParams(loc('', '#/reset-password')).code).toBe('');
  });

  it('does not mistake a bare fragment route for a query', () => {
    expect(readRecoveryParams(loc('', '#/reset-password')).error).toBe('');
  });

  it('surfaces an expired link reported as an error param', () => {
    const { error, errorDescription } = readRecoveryParams(
      loc('', '#/reset-password?error=access_denied&error_description=Email+link+is+invalid+or+has+expired'),
    );
    expect(error).toBe('access_denied');
    expect(errorDescription).toMatch(/expired/);
  });

  it('surfaces an error delivered in the query string too', () => {
    expect(
      readRecoveryParams(loc('?error=access_denied', '#/reset-password')).error,
    ).toBe('access_denied');
  });
});

// token_hash is what makes a recovery link work on the phone someone actually
// opened their mail on. PKCE cannot: requesting the reset stashes a
// code_verifier in that browser's localStorage, and without it the exchange
// fails looking exactly like an expired link. Both shapes have to be readable
// while old links are still in flight.
describe('readRecoveryParams — token_hash links', () => {
  it('finds a token_hash in the fragment, where the email template puts it', () => {
    const { tokenHash } = readRecoveryParams(
      loc('', '#/reset-password?token_hash=pkce_abc&type=recovery'),
    );
    expect(tokenHash).toBe('pkce_abc');
  });

  it('finds a token_hash in the query string too', () => {
    expect(
      readRecoveryParams(loc('?token_hash=pkce_abc&type=recovery', '#/reset-password'))
        .tokenHash,
    ).toBe('pkce_abc');
  });

  it('reports both when a link somehow carries each', () => {
    const p = readRecoveryParams(loc('?code=c1', '#/reset-password?token_hash=t1'));
    expect(p.tokenHash).toBe('t1');
    expect(p.code).toBe('c1');
  });

  it('leaves tokenHash empty on a legacy code-only link', () => {
    const p = readRecoveryParams(loc('?code=abc123', '#/reset-password'));
    expect(p.tokenHash).toBe('');
    expect(p.code).toBe('abc123');
  });
});

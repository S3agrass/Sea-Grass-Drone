import { describe, it, expect, beforeEach } from 'vitest';
import {
  captureRecoveryFragment,
  readRecoveryParams,
  takeRecoveryParams,
} from '../lib/auth';

// Getting a recovery link's payload out of the URL before the router eats it.
//
// The implicit flow hands the session back in the fragment
// (`#access_token=...&type=recovery`). This app mounts a HashRouter, so that
// fragment reads as a route literally named "access_token=..." — no <Route>
// matches, the catch-all fires, and the user is bounced to the login page while
// holding a perfectly valid session. That is exactly the "it just redirects me
// to the website" symptom, and nothing about it looks like an error: no message,
// no failed request, just the wrong page.
//
// captureRecoveryFragment runs before React and lifts the values out. These
// tests pin that, plus the three URL shapes a link can arrive in, because which
// one shows up depends on the email template and the flow — neither of which
// the app controls at read time.

// replaceState must actually mutate location here. A browser updates the address
// bar in place, and takeRecoveryParams falls back to reading the live URL when
// the stash is empty — so a fake that leaves location untouched would let a
// spent link keep reading as valid, and the replay test would pass for the wrong
// reason.
function fakeWindow(hash, search = '', pathname = '/desktop/') {
  const store = new Map();
  const win = {
    location: { hash, search, pathname },
    history: {
      replaceState: (_state, _title, url) => {
        store.set('__url', url);
        const [path, newHash = ''] = url.split('#');
        win.location.pathname = path;
        win.location.hash = newHash ? `#${newHash}` : '';
        win.location.search = '';
      },
    },
    sessionStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    __url: () => store.get('__url'),
  };
  return win;
}

describe('readRecoveryParams — all three link shapes', () => {
  it('reads an implicit-flow session out of a bare fragment', () => {
    const p = readRecoveryParams({
      search: '',
      hash: '#access_token=at123&refresh_token=rt456&type=recovery',
    });
    expect(p.accessToken).toBe('at123');
    expect(p.refreshToken).toBe('rt456');
    expect(p.type).toBe('recovery');
  });

  it('still reads a token_hash link after a hash route', () => {
    const p = readRecoveryParams({
      search: '',
      hash: '#/reset-password?token_hash=th789&type=recovery',
    });
    expect(p.tokenHash).toBe('th789');
  });

  it('still reads a PKCE code from the query string', () => {
    const p = readRecoveryParams({ search: '?code=c1', hash: '#/reset-password' });
    expect(p.code).toBe('c1');
  });

  it('finds nothing in an ordinary route', () => {
    const p = readRecoveryParams({ search: '', hash: '#/fleet' });
    expect(p.accessToken).toBe('');
    expect(p.code).toBe('');
    expect(p.tokenHash).toBe('');
  });
});

// The shape a real implicit-flow link actually arrives in, and the one that
// broke recovery in production.
//
// We used to ask Supabase to redirect to `/desktop/#/reset-password`, because
// the app hash-routes and that is the reset route. Supabase APPENDS its own
// fragment instead of replacing ours, so the link landed carrying two `#`:
//
//   /desktop/#/reset-password#access_token=...&type=recovery
//
// Splitting the fragment on `?` alone left the second `#` buried inside the
// first key, which parsed as `/reset-password#access_token` — the session was
// present in the URL and unreachable. `type=recovery` follows an `&` so it read
// correctly regardless, and that is what made the failure so misleading:
// captureRecoveryFragment recognised the link and rewrote the address bar, and
// then the reset page reported having no recovery link at all.
//
// resetRedirect() no longer puts a fragment on the redirect at all, so this
// shape should not arise any more. Pinned anyway: what Supabase appends to a
// redirect target is not ours to control, and the cost of being wrong about
// that is a recovery flow that fails while insisting the link is fine.
describe('readRecoveryParams — Supabase appended to our own fragment', () => {
  const doubled =
    '#/reset-password#access_token=at123&refresh_token=rt456&expires_in=3600&token_type=bearer&type=recovery';

  it('reads the session out from behind the second #', () => {
    const p = readRecoveryParams({ search: '', hash: doubled });
    expect(p.accessToken).toBe('at123');
    expect(p.refreshToken).toBe('rt456');
    expect(p.type).toBe('recovery');
  });

  it('does not leave the token stranded in a mangled key', () => {
    // The exact regression: type parsed, access_token did not, so the link read
    // as a recovery link with nothing in it.
    const p = readRecoveryParams({ search: '', hash: doubled });
    expect(p.type).toBe('recovery');
    expect(p.accessToken).not.toBe('');
  });

  it('reads a token_hash delivered the same way', () => {
    const p = readRecoveryParams({
      search: '',
      hash: '#/reset-password#token_hash=th789&type=recovery',
    });
    expect(p.tokenHash).toBe('th789');
  });

  it('reads an error appended to our fragment too', () => {
    const p = readRecoveryParams({
      search: '',
      hash: '#/reset-password#error=access_denied&error_description=Email+link+is+invalid+or+has+expired',
    });
    expect(p.error).toBe('access_denied');
    expect(p.errorDescription).toMatch(/expired/);
  });

  it('still rescues the session end to end', () => {
    const win = fakeWindow(doubled);
    captureRecoveryFragment(win);
    expect(win.__url()).toBe('/desktop/#/reset-password');
    expect(win.__url()).not.toContain('at123');
    expect(takeRecoveryParams(win).accessToken).toBe('at123');
  });
});

describe('captureRecoveryFragment', () => {
  let win;
  beforeEach(() => {
    win = fakeWindow('#access_token=at123&refresh_token=rt456&type=recovery');
  });

  it('rescues the session before the router can discard it', () => {
    const params = captureRecoveryFragment(win);
    expect(params.accessToken).toBe('at123');
  });

  it('rewrites the address bar to the reset route', () => {
    captureRecoveryFragment(win);
    expect(win.__url()).toBe('/desktop/#/reset-password');
  });

  it('leaves the tokens out of browser history', () => {
    captureRecoveryFragment(win);
    // replaceState, and the URL it writes carries no token material.
    expect(win.__url()).not.toContain('access_token');
    expect(win.__url()).not.toContain('at123');
  });

  it('hands the values on to the reset page', () => {
    captureRecoveryFragment(win);
    const taken = takeRecoveryParams(win);
    expect(taken.accessToken).toBe('at123');
    expect(taken.refreshToken).toBe('rt456');
  });

  it('consumes the stash, so a reload cannot replay a spent link', () => {
    captureRecoveryFragment(win);
    takeRecoveryParams(win);
    expect(takeRecoveryParams(win).accessToken).toBe('');
  });

  it('captures an error link so the page can explain itself', () => {
    const errWin = fakeWindow(
      '#error=access_denied&error_description=Email+link+is+invalid+or+has+expired',
    );
    const params = captureRecoveryFragment(errWin);
    expect(params.error).toBe('access_denied');
  });

  it('ignores ordinary navigation entirely', () => {
    const plain = fakeWindow('#/fleet');
    expect(captureRecoveryFragment(plain)).toBeNull();
    expect(plain.__url()).toBeUndefined();
  });

  it('does not hijack a signed-in user landing on the control page', () => {
    const plain = fakeWindow('#/control');
    expect(captureRecoveryFragment(plain)).toBeNull();
  });
});

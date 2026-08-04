import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Account recovery: getting a locked-out operator back in without a dashboard.
//
// The failure this exists to stop is real and already happened — an account was
// created, never confirmed, and the app offered no way out of that state. The
// password was right, the account existed, and the only fix was someone with
// Supabase dashboard access. Same story for a forgotten password: before this
// there was no reset anywhere in the product.
//
// Two things are pinned hard here because both are silent when broken:
//   * the recovery controls are type="button". They sit inside the sign-in
//     <form>, where the HTML default of type="submit" means clicking "Forgot
//     password?" would fire a sign-in attempt instead of sending an email.
//   * the resend action appears ONLY for email_not_confirmed. Offering it after
//     a wrong password would tell an attacker which addresses have accounts.

const { mockAuth } = vi.hoisted(() => ({
  mockAuth: {
    signIn: vi.fn(),
    signUp: vi.fn(),
    authed: false,
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => mockAuth,
  AuthProvider: ({ children }) => children,
}));

// The canvas effect is irrelevant here and jsdom cannot rasterise anyway.
vi.mock('../components/ParticleTitle', () => ({
  default: ({ text }) => <div>{text}</div>,
}));

const { sendPasswordReset, resendConfirmation } = vi.hoisted(() => ({
  sendPasswordReset: vi.fn(),
  resendConfirmation: vi.fn(),
}));

vi.mock('../lib/auth', () => ({
  sendPasswordReset,
  resendConfirmation,
}));

vi.mock('../lib/supabase', () => ({
  supabaseConfigured: true,
  supabase: {},
}));

const LoginPage = (await import('../pages/LoginPage')).default;
const ForgotPasswordPage = (await import('../pages/ForgotPasswordPage')).default;

const renderLogin = () =>
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.authed = false;
  sendPasswordReset.mockResolvedValue(undefined);
  resendConfirmation.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Asking for the reset link now happens on /forgot-password, not on a button
// inside the sign-in form. The old arrangement borrowed the address from the
// sign-in email field, so recovering an account required having already typed
// the right address into a form about something else, and an empty field got
// you told to go and fill it in rather than anything useful.
describe('password reset — the link out of the sign-in form', () => {
  it('offers a way to reach recovery from the sign-in tab', () => {
    renderLogin();
    expect(
      screen.getByRole('link', { name: /forgot password/i }),
    ).toHaveAttribute('href', '/forgot-password');
  });

  it('does not send anything from the sign-in form itself', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('link', { name: /forgot password/i }));

    // Navigating is the whole job. A link cannot submit the form it sits in,
    // which is what the old type="button" was defending against.
    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(mockAuth.signIn).not.toHaveBeenCalled();
  });
});

describe('forgot-password page', () => {
  const renderForgot = () =>
    render(
      <MemoryRouter initialEntries={['/forgot-password']}>
        <ForgotPasswordPage />
      </MemoryRouter>,
    );

  const submit = async (user, email) => {
    if (email) await user.type(screen.getByLabelText(/email/i), email);
    await user.click(screen.getByRole('button', { name: /send reset link/i }));
  };

  it('asks for the address on its own, rather than borrowing one', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user, 'locked@example.com');

    await waitFor(() =>
      expect(sendPasswordReset).toHaveBeenCalledWith('locked@example.com'),
    );
  });

  it('trims the address, because copied email tends to bring whitespace', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user, '  locked@example.com  ');

    await waitFor(() =>
      expect(sendPasswordReset).toHaveBeenCalledWith('locked@example.com'),
    );
  });

  it('asks for an address rather than emailing nobody', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /enter your email address/i,
    );
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it('does not reveal whether the account exists', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user, 'nobody@example.com');

    // "If an account exists" — the same wording either way.
    expect(await screen.findByText(/if an account exists/i)).toBeInTheDocument();
  });

  // Every failed attempt so far ended with someone clicking an older email, so
  // the confirmation says which one to open rather than just "check your mail".
  it('says the link is single-use and that a new request kills the old one', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user, 'locked@example.com');

    const status = await screen.findByRole('status');
    expect(status.closest('.login-card')).toHaveTextContent(/only be used once/i);
    expect(status.closest('.login-card')).toHaveTextContent(
      /invalidates the previous one/i,
    );
  });

  it('replaces the form once sent, so there is nothing to click twice', async () => {
    const user = userEvent.setup();
    renderForgot();

    await submit(user, 'locked@example.com');

    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: /send reset link/i }),
      ).not.toBeInTheDocument(),
    );
  });

  it('states the password rules before the email is even sent', () => {
    renderForgot();
    expect(screen.getByText(/at least 6 characters/i)).toBeInTheDocument();
    expect(
      screen.getByText(/different from your current password/i),
    ).toBeInTheDocument();
  });

  // The project's hourly email quota and the short per-address cooldown are
  // different problems with different fixes, and both used to render as "wait a
  // minute". For the quota that is simply false — it is an hour, it is
  // project-wide, and no amount of retrying from another account or device
  // helps. Being told to wait a minute sent us looking at passwords instead.
  it('names the hourly project email quota, and does not call it a minute', async () => {
    const user = userEvent.setup();
    sendPasswordReset.mockRejectedValue({ code: 'over_email_send_rate_limit' });
    renderForgot();

    await submit(user, 'locked@example.com');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/email limit/i);
    expect(alert).toHaveTextContent(/hour/i);
    expect(alert).not.toHaveTextContent(/wait a minute/i);
  });

  it('keeps the short per-address cooldown separate', async () => {
    const user = userEvent.setup();
    sendPasswordReset.mockRejectedValue({
      message: 'For security purposes, you can only request this once every 60 seconds',
    });
    renderForgot();

    await submit(user, 'locked@example.com');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/wait a minute/i);
    expect(alert).not.toHaveTextContent(/email limit/i);
  });

  it('keeps the form up after a failure, so the address is not retyped', async () => {
    const user = userEvent.setup();
    sendPasswordReset.mockRejectedValue({ code: 'over_email_send_rate_limit' });
    renderForgot();

    await submit(user, 'locked@example.com');

    await screen.findByRole('alert');
    expect(screen.getByLabelText(/email/i)).toHaveValue('locked@example.com');
  });
});

describe('sign-in form recovery errors', () => {

  it('explains an exhausted quota on sign-up too, where it also bites', async () => {
    const user = userEvent.setup();
    mockAuth.signUp.mockRejectedValue({ code: 'over_email_send_rate_limit' });
    renderLogin();

    await user.click(screen.getByRole('tab', { name: /sign up/i }));
    await user.type(screen.getByLabelText(/email/i), 'new@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/email limit/i);
    expect(alert).not.toHaveTextContent(/too many attempts/i);
  });
});

describe('confirmation resend', () => {
  const signInAs = async (user, code) => {
    mockAuth.signIn.mockRejectedValue({ code });
    await user.type(screen.getByLabelText(/email/i), 'unconfirmed@example.com');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: /^sign in$/i }));
  };

  it('is hidden until sign-in actually fails on a missing confirmation', () => {
    renderLogin();
    expect(
      screen.queryByRole('button', { name: /resend confirmation/i }),
    ).not.toBeInTheDocument();
  });

  it('appears after an email_not_confirmed failure', async () => {
    const user = userEvent.setup();
    renderLogin();
    await signInAs(user, 'email_not_confirmed');

    expect(
      await screen.findByRole('button', { name: /resend confirmation/i }),
    ).toHaveAttribute('type', 'button');
  });

  it('stays hidden after a wrong password, which would leak account existence', async () => {
    const user = userEvent.setup();
    renderLogin();
    await signInAs(user, 'invalid_credentials');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /incorrect email or password/i,
    );
    expect(
      screen.queryByRole('button', { name: /resend confirmation/i }),
    ).not.toBeInTheDocument();
  });

  it('re-sends to the address that failed', async () => {
    const user = userEvent.setup();
    renderLogin();
    await signInAs(user, 'email_not_confirmed');

    await user.click(
      await screen.findByRole('button', { name: /resend confirmation/i }),
    );

    await waitFor(() =>
      expect(resendConfirmation).toHaveBeenCalledWith('unconfirmed@example.com'),
    );
  });
});

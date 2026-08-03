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

describe('password reset', () => {
  it('offers a reset action on the sign-in tab', () => {
    renderLogin();
    expect(
      screen.getByRole('button', { name: /forgot password/i }),
    ).toBeInTheDocument();
  });

  it('is a plain button, so it cannot submit the sign-in form', () => {
    renderLogin();
    // The whole point: inside a <form>, the default type is "submit".
    expect(
      screen.getByRole('button', { name: /forgot password/i }),
    ).toHaveAttribute('type', 'button');
  });

  it('sends a reset without attempting a sign-in', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'locked@example.com');
    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    await waitFor(() =>
      expect(sendPasswordReset).toHaveBeenCalledWith('locked@example.com'),
    );
    expect(mockAuth.signIn).not.toHaveBeenCalled();
  });

  it('asks for an address rather than emailing nobody', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /enter your email address first/i,
    );
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it('does not reveal whether the account exists', async () => {
    const user = userEvent.setup();
    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    // "If an account exists" — the same wording either way.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /if an account exists/i,
    );
  });

  it('reports a send rate limit in plain language', async () => {
    const user = userEvent.setup();
    sendPasswordReset.mockRejectedValue({ code: 'over_email_send_rate_limit' });
    renderLogin();

    await user.type(screen.getByLabelText(/email/i), 'locked@example.com');
    await user.click(screen.getByRole('button', { name: /forgot password/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /too many emails requested/i,
    );
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

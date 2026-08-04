import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangePassword from '../components/ChangePassword';

// Letting a signed-in operator change their own password.
//
// Operators here get bootstrapped with a password an administrator set for them,
// so "I know my password and want a different one" is the normal case, not an
// edge one. Before this the only route to a new password was the forgot-password
// email, which is a strange thing to make someone do when they are already
// signed in — and impossible while the recovery redirect is misconfigured.
//
// The check that matters most is the current-password one. Supabase's
// updateUser() accepts a live session alone and never asks for the existing
// password, so without re-authenticating first, anyone passing an unattended
// console could lock out its owner. An unattended signed-in console is a normal
// state for a vehicle control station.

const { changePassword } = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock('../lib/auth', () => ({ changePassword }));

const EMAIL = 'operator@example.com';

const openForm = async (user) => {
  await user.click(screen.getByRole('button', { name: /^change password$/i }));
};

const fill = async (user, { current, next, confirm }) => {
  if (current !== undefined) await user.type(screen.getByLabelText(/current password/i), current);
  if (next !== undefined) await user.type(screen.getByLabelText(/^new password$/i), next);
  if (confirm !== undefined) await user.type(screen.getByLabelText(/confirm new password/i), confirm);
};

const save = async (user) => {
  await user.click(screen.getByRole('button', { name: /save new password/i }));
};

beforeEach(() => {
  vi.clearAllMocks();
  changePassword.mockResolvedValue(undefined);
});

describe('ChangePassword', () => {
  it('stays collapsed until asked for', () => {
    render(<ChangePassword email={EMAIL} />);
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('changes the password when everything checks out', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'Sonar-anchor-4644', next: 'new-passphrase', confirm: 'new-passphrase' });
    await save(user);

    await waitFor(() =>
      expect(changePassword).toHaveBeenCalledWith(EMAIL, 'Sonar-anchor-4644', 'new-passphrase'),
    );
  });

  it('requires the current password, so an unattended console is not a lockout', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { next: 'new-passphrase', confirm: 'new-passphrase' });
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/enter your current password/i);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('reports a wrong current password distinctly from any other failure', async () => {
    const user = userEvent.setup();
    changePassword.mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'invalid_current_password' }),
    );
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'wrong', next: 'new-passphrase', confirm: 'new-passphrase' });
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/current password is incorrect/i);
  });

  it('catches a mistyped confirmation before calling out', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'old-one', next: 'new-passphrase', confirm: 'new-passphrasr' });
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('rejects a password under the minimum', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'old-one', next: 'abc', confirm: 'abc' });
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/at least 6 characters/i);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('refuses a no-op change', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'same-password', next: 'same-password', confirm: 'same-password' });
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(/already your password/i);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('confirms success and closes the form', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'old-one', next: 'new-passphrase', confirm: 'new-passphrase' });
    await save(user);

    expect(await screen.findByText(/password changed/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('cancels without submitting', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    await fill(user, { current: 'old-one', next: 'new-passphrase', confirm: 'new-passphrase' });
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(changePassword).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/current password/i)).not.toBeInTheDocument();
  });

  it('gives Cancel type="button", or it would submit the form it abandons', async () => {
    const user = userEvent.setup();
    render(<ChangePassword email={EMAIL} />);
    await openForm(user);
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveAttribute('type', 'button');
  });
});

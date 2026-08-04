import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';

// "My settings don't save across a refresh." The write was failing and the page
// said "Saved ✓" anyway — setSaved(true) ran unconditionally, so a rejected
// write was indistinguishable from a successful one until the next reload put
// the old values back.

let mockDrone;
let mockAuth;

vi.mock('../context/DroneContext', () => ({ useDrone: () => mockDrone }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));
vi.mock('../components/TopBar', () => ({ default: () => null }));

function renderPage() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth = {
    user: { email: 'a@b.c' },
    localMode: false,
    supabaseConfigured: true,
    signOut: vi.fn(),
  };
  mockDrone = {
    activeDrone: {
      id: '1',
      name: 'Seagrass One',
      host: 'wss://control.seagrassrobotics.com',
      camera_url: 'https://cam.seagrassrobotics.com/cam/whep',
    },
    saveDrone: vi.fn(async () => ({ ok: true, error: null })),
    demoMode: false,
    setDemoMode: vi.fn(),
    disconnect: vi.fn(),
    autoRecord: false,
    setAutoRecord: vi.fn(),
    linkStatus: 'connected',
    toasts: [],
    dismissToast: vi.fn(),
  };
});

describe('SettingsPage — save feedback', () => {
  it('does NOT claim success when the write failed', async () => {
    const user = userEvent.setup();
    mockDrone.saveDrone = vi.fn(async () => ({
      ok: false,
      error: 'JWT expired',
    }));
    renderPage();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText(/jwt expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/saved ✓/i)).not.toBeInTheDocument();
  });

  it('confirms only on a real success', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: /save changes/i }));

    // The confirmation is a status region beside the button, not the button's
    // own label. Renaming the control that currently has focus is announced as
    // a different control appearing — and the old name came back two seconds
    // later, usually before a screen reader had reached it.
    // Scoped by name: the toast stack's polite region is also a role="status"
    // on this page.
    await waitFor(() =>
      expect(screen.getByRole('status', { name: /save status/i })).toHaveTextContent(
        /saved ✓/i,
      ),
    );
    expect(mockDrone.saveDrone).toHaveBeenCalledTimes(1);
  });

  it('renders the toast stack so provider errors are visible here too', () => {
    mockDrone.toasts = [{ id: 1, level: 'error', message: 'Could not save drone: nope' }];
    renderPage();

    expect(screen.getByText('Could not save drone: nope')).toBeInTheDocument();
  });
});

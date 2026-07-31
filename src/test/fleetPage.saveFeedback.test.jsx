import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import FleetPage from '../pages/FleetPage';

// Registering a drone appeared to do nothing: the modal closed, the fleet stayed
// empty, and no reason was given anywhere. Three things conspired — the write's
// error was reported as a toast, the page rendered no toasts, and the reload
// behind the write blanked the list on failure just as it does for an empty
// fleet. These cover the symptom: whatever fails, the operator is told.

let mockDrone;
vi.mock('../context/DroneContext', () => ({
  useDrone: () => mockDrone,
  DEFAULT_CAMERA_URL: 'https://cam.seagrassrobotics.com/cam/whep',
  DEFAULT_MEDIA_URL: 'https://media.seagrassrobotics.com',
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { email: 'a@b.c' }, localMode: false, signOut: vi.fn() }),
}));

function baseDrone(overrides) {
  return {
    fleet: [],
    fleetLoading: false,
    saveDrone: vi.fn(async () => ({ ok: true, error: null })),
    removeDrone: vi.fn(async () => ({ ok: true, error: null })),
    selectDrone: vi.fn(),
    toasts: [],
    dismissToast: vi.fn(),
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <FleetPage />
    </MemoryRouter>,
  );
}

async function openRegisterForm(user) {
  await user.click(screen.getByRole('button', { name: /register a drone/i }));
  await user.type(screen.getByPlaceholderText('Seagrass One'), 'Seagrass One');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FleetPage — media server URL', () => {
  // Only Settings had this field. A drone registered here kept a blank
  // media_url, and mediaBase then falls back to "camera host, port 8000" —
  // which for a camera served anywhere other than the Pi itself points at
  // nothing: Media page 404s, and WHEP loses its TURN credentials.
  it('offers the field, prefilled with the default', async () => {
    const user = userEvent.setup();
    mockDrone = baseDrone();
    renderPage();
    await openRegisterForm(user);
    expect(
      screen.getByDisplayValue('https://media.seagrassrobotics.com'),
    ).toBeInTheDocument();
  });

  it('saves what the operator typed', async () => {
    const user = userEvent.setup();
    const saveDrone = vi.fn(async () => ({ ok: true, error: null }));
    mockDrone = baseDrone({ saveDrone });
    renderPage();

    await openRegisterForm(user);
    const field = screen.getByDisplayValue('https://media.seagrassrobotics.com');
    await user.clear(field);
    await user.type(field, 'http://10.0.0.5:8000');
    await user.click(screen.getByRole('button', { name: /save drone/i }));

    await waitFor(() => expect(saveDrone).toHaveBeenCalled());
    expect(saveDrone.mock.calls[0][0]).toMatchObject({ media_url: 'http://10.0.0.5:8000' });
  });
});

describe('FleetPage — registration feedback', () => {
  it('shows why the save failed and keeps the form open', async () => {
    const user = userEvent.setup();
    mockDrone = baseDrone({
      saveDrone: vi.fn(async () => ({
        ok: false,
        error: 'new row violates row-level security policy',
      })),
    });
    renderPage();

    await openRegisterForm(user);
    await user.click(screen.getByRole('button', { name: /save drone/i }));

    await waitFor(() =>
      expect(screen.getByText(/row-level security policy/i)).toBeInTheDocument(),
    );
    // Still open — the typed name must not be thrown away on a failure.
    expect(screen.getByDisplayValue('Seagrass One')).toBeInTheDocument();
  });

  it('closes the form when the save succeeds', async () => {
    const user = userEvent.setup();
    mockDrone = baseDrone();
    renderPage();

    await openRegisterForm(user);
    await user.click(screen.getByRole('button', { name: /save drone/i }));

    await waitFor(() =>
      expect(screen.queryByDisplayValue('Seagrass One')).not.toBeInTheDocument(),
    );
    expect(mockDrone.saveDrone).toHaveBeenCalledTimes(1);
  });

  it('says a name is required instead of silently ignoring Save', async () => {
    const user = userEvent.setup();
    mockDrone = baseDrone();
    renderPage();

    await user.click(screen.getByRole('button', { name: /register a drone/i }));
    await user.click(screen.getByRole('button', { name: /save drone/i }));

    expect(await screen.findByText(/give the drone a name/i)).toBeInTheDocument();
    expect(mockDrone.saveDrone).not.toHaveBeenCalled();
  });

  it('renders the provider toast stack', () => {
    mockDrone = baseDrone({
      toasts: [{ id: 1, level: 'error', message: 'Could not save drone: boom' }],
    });
    renderPage();

    expect(screen.getByText('Could not save drone: boom')).toBeInTheDocument();
  });
});

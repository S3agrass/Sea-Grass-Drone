import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ControlPage from '../pages/ControlPage';

// Every layout dial in theme.css is at its floor — --sonar-h at 84px, gaps at
// 8px, the left rail already deleted — so "make the map bigger" cannot be paid
// for out of spacing any more. Focus mode borrows the whole deck instead, and
// the choice is remembered: an operator who wants the map big wants it big for
// the survey, not for one render.

// Leaflet needs a real layout engine; jsdom has none, so the map itself is
// stubbed. What matters here is the deck's layout state, not tile rendering.
vi.mock('../components/DroneMap', () => ({
  default: ({ focused, onToggleFocus }) => (
    <button onClick={onToggleFocus}>
      {focused ? '⤡ Exit focus' : '⛶ Focus map'}
    </button>
  ),
}));

vi.mock('../components/CameraView', () => ({ default: () => <div>camera</div> }));
vi.mock('../components/GamepadControl', () => ({ default: () => <div>gamepad</div> }));
vi.mock('../components/SonarView', () => ({ default: () => <div>sonar</div> }));
vi.mock('../components/ConnectionPanel', () => ({ default: () => <div>link</div> }));
vi.mock('../components/TopBar', () => ({ default: () => <div>topbar</div> }));
vi.mock('../components/Toasts', () => ({ default: () => null }));

vi.mock('../context/DroneContext', () => ({
  useDrone: () => ({
    activeDrone: { id: 'd1', name: 'Sim' },
    telemetry: {},
    sonar: {},
    pid: {},
    headingHold: {},
    headingHoldOn: vi.fn(),
    headingHoldOff: vi.fn(),
    armed: false,
  }),
}));

function renderDeck() {
  return render(
    <MemoryRouter>
      <ControlPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe('map focus mode', () => {
  it('starts off, so the default deck is unchanged', () => {
    const { container } = renderDeck();
    expect(container.querySelector('.deck')).not.toHaveClass('map-focus');
  });

  it('gives the map the whole deck when asked, and hands it back', async () => {
    const user = userEvent.setup();
    const { container } = renderDeck();

    await user.click(screen.getByRole('button', { name: /focus map/i }));
    expect(container.querySelector('.deck')).toHaveClass('map-focus');

    await user.click(screen.getByRole('button', { name: /exit focus/i }));
    expect(container.querySelector('.deck')).not.toHaveClass('map-focus');
  });

  it('keeps the other panels mounted while focused', async () => {
    // Hidden by CSS rather than unmounted: the camera keeps its WHEP
    // connection and the sonar keeps its echogram history, so coming back
    // shows live panels instead of three that have to reconnect and refill.
    const user = userEvent.setup();
    renderDeck();

    await user.click(screen.getByRole('button', { name: /focus map/i }));

    expect(screen.getByText('camera')).toBeInTheDocument();
    expect(screen.getByText('sonar')).toBeInTheDocument();
    expect(screen.getByText('gamepad')).toBeInTheDocument();
  });

  it('remembers focus across a reload', () => {
    localStorage.setItem('seagrass-map-focus', '1');
    const { container } = renderDeck();
    expect(container.querySelector('.deck')).toHaveClass('map-focus');
  });

  it('persists the choice when toggled', async () => {
    const user = userEvent.setup();
    renderDeck();

    await user.click(screen.getByRole('button', { name: /focus map/i }));
    expect(localStorage.getItem('seagrass-map-focus')).toBe('1');

    await user.click(screen.getByRole('button', { name: /exit focus/i }));
    expect(localStorage.getItem('seagrass-map-focus')).toBe('0');
  });
});

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
let lastMapProps;
vi.mock('../components/DroneMap', () => ({
  default: (props) => {
    lastMapProps = props;
    return (
      <button onClick={props.onToggleFocus}>
        {props.focused ? '⤡ Exit focus' : '⛶ Focus map'}
      </button>
    );
  },
}));

vi.mock('../components/CameraView', () => ({ default: () => <div>camera</div> }));
vi.mock('../components/GamepadControl', () => ({ default: () => <div>gamepad</div> }));
vi.mock('../components/SonarView', () => ({ default: () => <div>sonar</div> }));
vi.mock('../components/ConnectionPanel', () => ({ default: () => <div>link</div> }));
vi.mock('../components/TopBar', () => ({ default: () => <div>topbar</div> }));
vi.mock('../components/Toasts', () => ({ default: () => null }));

let telemetry = {};
vi.mock('../context/DroneContext', () => ({
  useDrone: () => ({
    activeDrone: { id: 'd1', name: 'Sim' },
    telemetry,
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
  telemetry = {};
});

describe('deck layout', () => {
  // The strips used to be two stacked rows and the deck paid for both their
  // heights. Row 1 — map and camera — is the only 1fr, so that came straight
  // off the two things the operator actually watches.
  it('puts instruments and sonar in one row, not two', () => {
    const { container } = renderDeck();
    const strip = container.querySelector('.deck-strip');
    expect(strip).toBeInTheDocument();
    expect(strip.querySelector('.inst-cluster')).toBeInTheDocument();
    expect(strip).toContainElement(screen.getByText('sonar'));
  });

  it('keeps the strip a direct child of the deck, so focus mode still hides it', () => {
    // Focus mode hides `.deck > *:not(.deck-map)`. Nesting the strip any deeper
    // would leave it on screen with the map supposedly full-bleed.
    const { container } = renderDeck();
    expect(container.querySelector('.deck > .deck-strip')).toBeInTheDocument();
  });
});

describe('instrument strip fold', () => {
  // Row 1 — map and camera — is the deck's only 1fr, so it takes whatever the
  // strips give up. Folding this is the way to make that row taller while
  // keeping the camera on screen, which focus mode does not.
  it('starts open', () => {
    const { container } = renderDeck();
    expect(container.querySelector('.inst-cluster')).not.toHaveClass('collapsed');
  });

  it('folds and unfolds', async () => {
    const user = userEvent.setup();
    const { container } = renderDeck();

    await user.click(screen.getByRole('button', { expanded: true }));
    expect(container.querySelector('.inst-cluster')).toHaveClass('collapsed');

    await user.click(screen.getByRole('button', { expanded: false }));
    expect(container.querySelector('.inst-cluster')).not.toHaveClass('collapsed');
  });

  it('remembers the fold across a reload', () => {
    localStorage.setItem('seagrass-inst-collapsed', '1');
    const { container } = renderDeck();
    expect(container.querySelector('.inst-cluster')).toHaveClass('collapsed');
  });

  it('keeps the instruments mounted while folded', () => {
    // Hidden by CSS, like the panels in focus mode: the link panel keeps its
    // state rather than remounting every time the strip is reopened.
    localStorage.setItem('seagrass-inst-collapsed', '1');
    renderDeck();
    expect(screen.getByText('link')).toBeInTheDocument();
  });
});

describe('drone position on the deck', () => {
  // The Pixhawk reports 0/0 until it has a GPS fix. Passed through, it put the
  // drone at Null Island and ran the route line from every waypoint off the
  // bottom-right of the map towards it.
  it('withholds a position while there is no GPS fix', () => {
    telemetry = { lat: 0, lon: 0 };
    renderDeck();
    expect(lastMapProps.dronePos).toBe(null);
  });

  it('passes a real position through', () => {
    telemetry = { lat: 37.8065, lon: -122.4305 };
    renderDeck();
    expect(lastMapProps.dronePos).toEqual([37.8065, -122.4305]);
  });

  it('withholds a position when telemetry has none yet', () => {
    telemetry = {};
    renderDeck();
    expect(lastMapProps.dronePos).toBe(null);
  });
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

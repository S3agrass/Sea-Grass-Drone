import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import SettingsPage from '../pages/SettingsPage';
import FleetPage from '../pages/FleetPage';
import ConnectionPanel from '../components/ConnectionPanel';
import FlightStatus from '../components/FlightStatus';
import WaypointList from '../components/WaypointList';

// Accessibility regressions are silent: the page still looks right, the tests
// still pass, and the defect only shows up for someone using a screen reader.
// These lock down the properties that carry the most weight and have no visual
// consequence — accessible names, live regions, landmark and heading structure,
// and the keyboard paths that had none.

vi.mock('../components/TopBar', () => ({ default: () => <div>topbar</div> }));
vi.mock('../components/Toasts', () => ({ default: () => null }));

let mockDrone;
let mockAuth;

vi.mock('../context/DroneContext', async () => {
  const actual = await vi.importActual('../context/DroneContext');
  return { ...actual, useDrone: () => mockDrone };
});
vi.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }));

beforeEach(() => {
  mockDrone = {
    activeDrone: { id: 'd1', name: 'Sim', host: 'ws://x', camera_url: '', media_url: '', token: '' },
    fleet: [{ id: 'd1', name: 'Sim', host: 'ws://x', camera_url: '' }],
    fleetLoading: false,
    saveDrone: vi.fn(async () => ({ ok: true })),
    removeDrone: vi.fn(async () => ({ ok: true })),
    selectDrone: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn(),
    demoMode: false,
    setDemoMode: vi.fn(),
    autoRecord: false,
    setAutoRecord: vi.fn(),
    linkStatus: 'connected',
    armed: false,
    flightMode: 'MANUAL',
    pixhawkOk: true,
    recording: false,
    telemetry: { depth: 1.4, altitude: 0.2, climb: 0, groundspeed: 0.5, battery: 80, heading: 90, roll: 0, pitch: 0 },
    sonar: { distance_m: 4.2, quality: 'good' },
    reportedDroneId: null,
    droneIdMismatch: null,
    link: { arm: vi.fn(() => true), disarm: vi.fn(() => true) },
    pushToast: vi.fn(),
    toasts: [],
    dismissToast: vi.fn(),
  };
  mockAuth = { user: { email: 'a@b.c', id: 'u1' }, localMode: false, signOut: vi.fn(), supabaseConfigured: true };
});

const renderIn = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

describe('landmarks and headings', () => {
  it('gives Settings a main landmark and a heading per card', () => {
    renderIn(<SettingsPage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    // Card titles were <div class="eyebrow"> — styled like headings, invisible
    // to anything navigating by structure.
    for (const name of [/active drone/i, /presentation/i, /recording/i, /control mapping/i, /account/i]) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  it('names each Settings section as a region so the rotor can list them', () => {
    renderIn(<SettingsPage />);
    expect(screen.getByRole('region', { name: /active drone/i })).toBeInTheDocument();
  });

  it('gives the fleet a main landmark and a heading per drone', () => {
    renderIn(<FleetPage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sim' })).toBeInTheDocument();
  });

  it('exposes the fleet as a list, not a run of divs', () => {
    renderIn(<FleetPage />);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('form labelling', () => {
  it('names every Settings field without swallowing its help text', () => {
    renderIn(<SettingsPage />);
    // The wrapping-label pattern folded the help paragraph into the field's
    // accessible name; Drone ID also had a whole <button> inside it.
    const droneId = screen.getByLabelText('Drone ID');
    expect(droneId).toBeInTheDocument();
    expect(droneId).toHaveAccessibleDescription(/drone's own name for itself/i);
    expect(droneId.getAttribute('aria-label')).toBeNull();
  });

  it('keeps "Edit anyway" out of the Drone ID field name', () => {
    renderIn(<SettingsPage />);
    expect(screen.getByLabelText('Drone ID')).toHaveAccessibleName('Drone ID');
    expect(screen.getByRole('button', { name: /edit drone id anyway/i })).toBeInTheDocument();
  });

  it('names every field in the drone editor dialog', async () => {
    const user = userEvent.setup();
    renderIn(<FleetPage />);
    await user.click(screen.getByRole('button', { name: /add drone/i }));

    const dialog = screen.getByRole('dialog', { name: /register drone/i });
    for (const label of [/^name$/i, /drone link/i, /camera stream url/i, /media server url/i, /access token/i]) {
      expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
    }
  });
});

describe('status and error announcement', () => {
  it('puts a save failure in an assertive live region', async () => {
    const user = userEvent.setup();
    mockDrone.saveDrone = vi.fn(async () => ({ ok: false, error: 'JWT expired' }));
    renderIn(<FleetPage />);

    await user.click(screen.getByRole('button', { name: /add drone/i }));
    await user.type(screen.getByLabelText(/^name$/i), 'X');
    await user.click(screen.getByRole('button', { name: /save drone/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/jwt expired/i);
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('announces the fleet loading state', () => {
    mockDrone.fleetLoading = true;
    renderIn(<FleetPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading fleet/i);
  });
});

describe('safety-critical state', () => {
  it('binds each link value to the term that names it', () => {
    render(<ConnectionPanel />);
    // "Thrusters" and "DISARMED" were adjacent spans with nothing tying them.
    const region = screen.getByRole('region', { name: /drone link/i });
    expect(within(region).getByText('Thrusters').tagName).toBe('DT');
    expect(within(region).getByText('DISARMED').tagName).toBe('DD');
  });

  it('keeps the Arm button reachable while blocked, with the reason attached', () => {
    mockDrone.pixhawkOk = false;
    render(<ConnectionPanel />);
    const arm = screen.getByRole('button', { name: /arm thrusters/i });
    // Not `disabled` — that removes it from the tab order and takes the
    // explanation with it.
    expect(arm).toHaveAttribute('aria-disabled', 'true');
    expect(arm).toHaveAccessibleDescription(/heartbeat/i);
  });

  it('announces arming as an alert, and only on the transition', () => {
    const { rerender } = render(<FlightStatus />);
    const alert = screen.getByRole('alert');
    // Mounting must not announce the state it started in.
    expect(alert).toBeEmptyDOMElement();

    mockDrone = { ...mockDrone, armed: true };
    rerender(<FlightStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent(/thrusters armed/i);
  });

  it('announces the link dropping', () => {
    const { rerender } = render(<FlightStatus />);
    mockDrone = { ...mockDrone, linkStatus: 'disconnected' };
    rerender(<FlightStatus />);
    expect(screen.getByRole('alert')).toHaveTextContent(/link lost/i);
  });

  it('reads a full telemetry summary on demand, and stays silent until asked', async () => {
    const user = userEvent.setup();
    render(<FlightStatus />);

    // Quiet by default: live telemetry in an aria-live region would talk
    // continuously and drown out the alerts that matter.
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();

    await user.click(screen.getByRole('button', { name: /read flight status/i }));
    expect(status).toHaveTextContent(/depth 1.4 metres/i);
    expect(status).toHaveTextContent(/battery 80 percent/i);
    expect(status).toHaveTextContent(/thrusters disarmed/i);
  });
});

describe('keyboard route editing', () => {
  // Waypoints could only be placed by clicking the Leaflet canvas, and the only
  // removal was "clear all" — route planning was mouse-only, which is a plain
  // SC 2.1.1 failure that no amount of labelling fixes.
  it('adds a waypoint from typed coordinates', async () => {
    const user = userEvent.setup();
    const onAddWaypoint = vi.fn();
    render(<WaypointList waypoints={[]} onAddWaypoint={onAddWaypoint} />);

    await user.type(screen.getByLabelText(/latitude/i), '37.8065');
    await user.type(screen.getByLabelText(/longitude/i), '-122.4305');
    await user.click(screen.getByRole('button', { name: /^add waypoint$/i }));

    expect(onAddWaypoint).toHaveBeenCalledWith([37.8065, -122.4305]);
  });

  it('rejects out-of-range coordinates into an alert', async () => {
    const user = userEvent.setup();
    const onAddWaypoint = vi.fn();
    render(<WaypointList waypoints={[]} onAddWaypoint={onAddWaypoint} />);

    await user.type(screen.getByLabelText(/latitude/i), '999');
    await user.type(screen.getByLabelText(/longitude/i), '0');
    await user.click(screen.getByRole('button', { name: /^add waypoint$/i }));

    expect(onAddWaypoint).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/latitude must be between/i);
  });

  it('adds at the drone position, and says why it cannot without a fix', () => {
    const { rerender } = render(<WaypointList waypoints={[]} dronePos={null} />);
    const add = screen.getByRole('button', { name: /add at drone position/i });
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add).toHaveAccessibleDescription(/no gps fix/i);

    const onAddWaypoint = vi.fn();
    rerender(<WaypointList waypoints={[]} dronePos={[1, 2]} onAddWaypoint={onAddWaypoint} />);
    screen.getByRole('button', { name: /add at drone position/i }).click();
    expect(onAddWaypoint).toHaveBeenCalledWith([1, 2]);
  });

  it('removes one waypoint rather than the whole route', async () => {
    const user = userEvent.setup();
    const onRemoveWaypoint = vi.fn();
    render(
      <WaypointList
        waypoints={[[1, 2], [3, 4]]}
        onRemoveWaypoint={onRemoveWaypoint}
      />,
    );

    // Named per waypoint — a column of identical "Remove" buttons is unusable
    // without the visual context.
    await user.click(screen.getByRole('button', { name: /remove waypoint 2 at 3.00000, 4.00000/i }));
    expect(onRemoveWaypoint).toHaveBeenCalledWith(1);
  });
});

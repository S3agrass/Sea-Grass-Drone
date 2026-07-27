import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SonarView from '../components/SonarView';

// Mocks the context wholesale, same as cameraView.test.jsx. jsdom has no 2D
// canvas context, so the draw loop bails at its `if (!ctx) return` guard — the
// drawing itself is covered indirectly through sonarGeometry.test.js, which
// tests the maths that can actually be wrong.
vi.mock('../context/DroneContext', () => ({
  useDrone: () => mockCtx,
}));

let mockCtx;
let subscribers;

beforeEach(() => {
  localStorage.clear();
  subscribers = [];
  mockCtx = {
    link: {
      subscribe: (fn) => {
        subscribers.push(fn);
        return () => {
          subscribers = subscribers.filter((s) => s !== fn);
        };
      },
    },
    sonar: {
      distance_m: null, raw_m: null, confidence: null, quality: 'none', ok: false,
      brake: 0, braking: false,
    },
    telemetry: { pitch: null },
    demoMode: false,
  };
  vi.clearAllMocks();
});

describe('SonarView', () => {
  it('renders the echogram canvas and the beam cone', () => {
    const { container } = render(<SonarView />);
    expect(container.querySelector('canvas.sonar-echo-canvas')).toBeInTheDocument();
    expect(screen.getByLabelText('Sonar beam cone')).toBeInTheDocument();
  });

  it('shows OFF and an offline hint when the sonar link is down', () => {
    render(<SonarView />);
    expect(screen.getByText('OFF')).toBeInTheDocument();
    expect(screen.getByText(/sonar offline/i)).toBeInTheDocument();
  });

  it('shows the lock state once the sonar link is up', () => {
    mockCtx.sonar = { ...mockCtx.sonar, ok: true, quality: 'good' };
    render(<SonarView />);
    expect(screen.getByText('LOCK')).toBeInTheDocument();
    expect(screen.queryByText(/sonar offline/i)).not.toBeInTheDocument();
  });

  it('subscribes to the link so profiles bypass context state', () => {
    render(<SonarView />);
    expect(subscribers.length).toBe(1);
  });

  it('does not subscribe to the link in demo mode', () => {
    mockCtx.demoMode = true;
    render(<SonarView />);
    expect(subscribers.length).toBe(0);
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<SonarView />);
    expect(subscribers.length).toBe(1);
    unmount();
    expect(subscribers.length).toBe(0);
  });

  it('defaults the mount angle to 45 degrees and persists a change', () => {
    render(<SonarView />);
    const slider = screen.getByLabelText('Sonar mount angle off vertical');
    expect(slider).toHaveValue('45');
    fireEvent.change(slider, { target: { value: '60' } });
    expect(screen.getByText('60°')).toBeInTheDocument();
    expect(localStorage.getItem('seagrass-sonar-mount-deg')).toBe('60');
  });

  it('restores a saved mount angle', () => {
    localStorage.setItem('seagrass-sonar-mount-deg', '30');
    render(<SonarView />);
    expect(screen.getByLabelText('Sonar mount angle off vertical')).toHaveValue('30');
  });

  it('persists the selected max range', () => {
    render(<SonarView />);
    const select = screen.getByLabelText('Echogram max range');
    fireEvent.change(select, { target: { value: '20' } });
    expect(localStorage.getItem('seagrass-sonar-max-range')).toBe('20');
  });

  it('ignores a saved max range that is not one of the offered choices', () => {
    localStorage.setItem('seagrass-sonar-max-range', '999');
    render(<SonarView />);
    expect(screen.getByLabelText('Echogram max range')).toHaveValue('10');
  });

  it('toggles pitch correction and freeze', () => {
    render(<SonarView />);
    const pitch = screen.getByText(/^pitch/);
    expect(pitch).toHaveTextContent('pitch on');
    fireEvent.click(pitch);
    expect(screen.getByText(/^pitch/)).toHaveTextContent('pitch off');

    const freeze = screen.getByText('freeze');
    fireEvent.click(freeze);
    expect(screen.getByText('resume')).toBeInTheDocument();
  });

  it('shows placeholder dashes for range/ahead/below before any ping', () => {
    render(<SonarView />);
    // range, ahead, below, conf all unknown => four em dashes.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('swaps the plan view for the POV canvas and persists the choice', () => {
    render(<SonarView />);
    expect(screen.getByLabelText('Sonar beam cone')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sonar POV view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('plan'));
    expect(screen.getByLabelText('Sonar POV view')).toBeInTheDocument();
    expect(screen.queryByLabelText('Sonar beam cone')).not.toBeInTheDocument();
    expect(localStorage.getItem('seagrass-sonar-view')).toBe('pov');

    fireEvent.click(screen.getByText('pov'));
    expect(screen.getByLabelText('Sonar beam cone')).toBeInTheDocument();
    expect(localStorage.getItem('seagrass-sonar-view')).toBe('plan');
  });

  it('restores a saved POV view', () => {
    localStorage.setItem('seagrass-sonar-view', 'pov');
    render(<SonarView />);
    expect(screen.getByLabelText('Sonar POV view')).toBeInTheDocument();
  });

  it('keeps the echogram mounted while the POV view is showing', () => {
    // The two views share one rAF loop; if toggling unmounted the echogram the
    // history would be wiped every time the operator looked at the tunnel.
    localStorage.setItem('seagrass-sonar-view', 'pov');
    const { container } = render(<SonarView />);
    expect(container.querySelector('canvas.sonar-echo-canvas')).toBeInTheDocument();
  });

  it('warns that a straight-down mount has no forward reach', () => {
    // The wedge collapses to nothing at 0deg; saying so in words is the only
    // way the operator learns the sonar brake cannot see a wall at that tilt.
    localStorage.setItem('seagrass-sonar-mount-deg', '0');
    mockCtx.telemetry = { pitch: 0 };
    render(<SonarView />);
    expect(screen.getByText('no forward reach')).toBeInTheDocument();
  });

  it('does not warn about forward reach at the default 45 degree mount', () => {
    render(<SonarView />);
    expect(screen.queryByText('no forward reach')).not.toBeInTheDocument();
  });

  it('explains the throttle when the sonar brake is holding forward thrust', () => {
    mockCtx.sonar = { ...mockCtx.sonar, ok: true, quality: 'good', brake: 1, braking: true };
    render(<SonarView />);
    expect(screen.getByText(/FWD STOP/)).toBeInTheDocument();
  });

  it('shows the partial limit while the brake is only easing off', () => {
    mockCtx.sonar = { ...mockCtx.sonar, ok: true, quality: 'good', brake: 0.6, braking: true };
    render(<SonarView />);
    expect(screen.getByText(/FWD capped to 40%/)).toBeInTheDocument();
  });

  it('says nothing about braking when nothing is close', () => {
    mockCtx.sonar = { ...mockCtx.sonar, ok: true, quality: 'good', brake: 0, braking: false };
    render(<SonarView />);
    expect(screen.queryByText(/FWD/)).not.toBeInTheDocument();
  });
});

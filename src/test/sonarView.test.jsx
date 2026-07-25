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
    sonar: { distance_m: null, raw_m: null, confidence: null, quality: 'none', ok: false },
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
});

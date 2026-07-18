import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CameraView from '../components/CameraView';

// ---- helpers ----

// streamType is not exported directly, so we test it via CameraView's rendered output.

const mockDrone = {
  activeDrone: { camera_url: 'http://100.64.0.1:8889/cam/whep' },
  linkStatus: 'connected',
  cameraActive: false,
  cameraOn: vi.fn(),
  cameraOff: vi.fn(),
  detectActive: false,
  detections: [],
  detectOn: vi.fn(),
  detectOff: vi.fn(),
  recording: false,
  recElapsed: 0,
  recordStart: vi.fn(),
  recordStop: vi.fn(),
  capturePhoto: vi.fn(),
};

// Replace useDrone with our mock.
vi.mock('../context/DroneContext', () => ({
  useDrone: () => mockCtx,
}));

let mockCtx;

beforeEach(() => {
  mockCtx = {
    ...mockDrone,
    cameraOn: vi.fn(),
    cameraOff: vi.fn(),
    detectOn: vi.fn(),
    detectOff: vi.fn(),
    recordStart: vi.fn(),
    recordStop: vi.fn(),
    capturePhoto: vi.fn(),
  };
  vi.clearAllMocks();
});

describe('CameraView — power toggle', () => {
  it('shows "Off" toggle when camera is inactive', () => {
    render(<CameraView />);
    const btn = screen.getByRole('button', { name: /off/i });
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('calls cameraOn when toggle is clicked while off', () => {
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /off/i }));
    expect(mockCtx.cameraOn).toHaveBeenCalledOnce();
  });

  it('shows "On" toggle when camera is active', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /on/i })).toBeInTheDocument();
  });

  it('calls cameraOff when toggle is clicked while on', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /on/i }));
    expect(mockCtx.cameraOff).toHaveBeenCalledOnce();
  });

  it('disables toggle when drone is not connected', () => {
    mockCtx.linkStatus = 'disconnected';
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /off/i })).toBeDisabled();
  });

  it('disables toggle when no camera URL is set', () => {
    mockCtx.activeDrone = { camera_url: '' };
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /off/i })).toBeDisabled();
  });
});

describe('CameraView — placeholder states', () => {
  it('shows "Camera is off" when camera inactive', () => {
    render(<CameraView />);
    expect(screen.getByText(/camera is off/i)).toBeInTheDocument();
  });

  it('shows "No stream URL configured" when camera_url is empty', () => {
    mockCtx.activeDrone = { camera_url: '' };
    render(<CameraView />);
    expect(screen.getByText(/no stream url configured/i)).toBeInTheDocument();
  });

  it('disables Snapshot and Record when the camera is off', () => {
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /snapshot/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /record/i })).toBeDisabled();
  });

  it('disables Expand when not live', () => {
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /expand/i })).toBeDisabled();
  });
});

describe('CameraView — capture + recording (Pi-side)', () => {
  it('enables Snapshot and Record once the camera is on', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /snapshot/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /record/i })).not.toBeDisabled();
  });

  it('calls capturePhoto when Snapshot is clicked', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /snapshot/i }));
    expect(mockCtx.capturePhoto).toHaveBeenCalledOnce();
  });

  it('calls recordStart when Record is clicked while idle', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /record/i }));
    expect(mockCtx.recordStart).toHaveBeenCalledOnce();
  });

  it('shows the REC badge and calls recordStop when recording', () => {
    mockCtx.cameraActive = true;
    mockCtx.recording = true;
    mockCtx.recElapsed = 65;
    render(<CameraView />);
    expect(screen.getByText(/REC 01:05/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(mockCtx.recordStop).toHaveBeenCalledOnce();
  });
});

describe('CameraView — detection toggle', () => {
  it('disables the AI toggle when the camera is off', () => {
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /^ai$/i })).toBeDisabled();
  });

  it('enables the AI toggle when connected and camera is on', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /^ai$/i })).not.toBeDisabled();
  });

  it('calls detectOn when the AI toggle is clicked while off', () => {
    mockCtx.cameraActive = true;
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /^ai$/i }));
    expect(mockCtx.detectOn).toHaveBeenCalledOnce();
  });

  it('calls detectOff when the AI toggle is clicked while on', () => {
    mockCtx.cameraActive = true;
    mockCtx.detectActive = true;
    render(<CameraView />);
    fireEvent.click(screen.getByRole('button', { name: /^ai$/i }));
    expect(mockCtx.detectOff).toHaveBeenCalledOnce();
  });

  it('renders the detection overlay canvas for a WHEP stream', () => {
    mockCtx.cameraActive = true;
    const { container } = render(<CameraView />);
    expect(container.querySelector('canvas.detection-overlay')).toBeInTheDocument();
  });
});

describe('CameraView — standalone viewing (no drone link)', () => {
  it('renders the MJPEG feed from the URL when NOT connected to the drone', () => {
    mockCtx.linkStatus = 'disconnected';
    mockCtx.cameraActive = false;
    mockCtx.activeDrone = { camera_url: 'http://pi.local:8000/stream.mjpg' };
    const { container } = render(<CameraView />);
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'http://pi.local:8000/stream.mjpg');
    // no "Camera is off" placeholder in standalone mode
    expect(screen.queryByText(/camera is off/i)).not.toBeInTheDocument();
  });

  it('renders the WebRTC video element when NOT connected', () => {
    mockCtx.linkStatus = 'disconnected';
    mockCtx.cameraActive = false;
    const { container } = render(<CameraView />);
    expect(container.querySelector('video')).toBeInTheDocument();
  });

  it('keeps Snapshot/Record disabled in standalone view (they need the server)', () => {
    mockCtx.linkStatus = 'disconnected';
    mockCtx.activeDrone = { camera_url: 'http://pi.local:8000/stream.mjpg' };
    render(<CameraView />);
    expect(screen.getByRole('button', { name: /snapshot/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /record/i })).toBeDisabled();
  });

  it('still shows "Camera is off" when connected but the server camera is off', () => {
    mockCtx.linkStatus = 'connected';
    mockCtx.cameraActive = false;
    mockCtx.activeDrone = { camera_url: 'http://pi.local:8000/stream.mjpg' };
    const { container } = render(<CameraView />);
    expect(screen.getByText(/camera is off/i)).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });
});

describe('CameraView — stream type detection', () => {
  it('renders <video> for a WHEP URL', () => {
    mockCtx.cameraActive = true;
    const { container } = render(<CameraView />);
    expect(container.querySelector('video')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
  });

  it('renders <img> for an MJPEG URL', () => {
    mockCtx.activeDrone = { camera_url: 'http://pi.local:8000/stream.mjpg' };
    mockCtx.cameraActive = true;
    const { container } = render(<CameraView />);
    expect(container.querySelector('img')).toBeInTheDocument();
    expect(container.querySelector('video')).not.toBeInTheDocument();
  });
});

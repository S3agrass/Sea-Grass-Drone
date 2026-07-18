import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MediaPage from '../pages/MediaPage';

// MediaPage talks directly to the Pi's media HTTP server; mock useDrone (also
// satisfies TopBar + Toasts) and global.fetch.
let mockCtx;
vi.mock('../context/DroneContext', () => ({ useDrone: () => mockCtx }));

const SAMPLE = [
  { name: 'rec-1.mp4', type: 'video', size: 2048, mtime: 1700000000, url: '/media/rec-1.mp4' },
  { name: 'photo-1.jpg', type: 'photo', size: 7092, mtime: 1700000100, url: '/media/photo-1.jpg' },
];

function renderPage() {
  return render(
    <MemoryRouter>
      <MediaPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockCtx = {
    mediaBase: 'http://pi.local:8000',
    activeDrone: { name: 'Seagrass One', token: 'secret', camera_url: 'http://pi.local:8000/stream.mjpg' },
    pushToast: vi.fn(),
    // TopBar needs these:
    linkStatus: 'connected',
    telemetry: { lat: null, lon: null },
    demoMode: false,
    // Toasts needs these:
    toasts: [],
    dismissToast: vi.fn(),
  };
  global.fetch = vi.fn((url, opts = {}) => {
    if (url.endsWith('/media') && !opts.method) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ media: SAMPLE }) });
    }
    if (opts.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ deleted: 'x' }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => vi.restoreAllMocks());

describe('MediaPage', () => {
  it('lists media from the drone with download links', async () => {
    renderPage();
    expect(await screen.findByText('rec-1.mp4')).toBeInTheDocument();
    expect(screen.getByText('photo-1.jpg')).toBeInTheDocument();
    const dl = screen.getAllByText(/download/i)[0].closest('a');
    expect(dl).toHaveAttribute('href', 'http://pi.local:8000/media/rec-1.mp4');
  });

  it('deletes an item via authenticated DELETE and drops it from the grid', async () => {
    renderPage();
    await screen.findByText('photo-1.jpg');
    const cards = screen.getAllByText(/delete/i);
    fireEvent.click(cards[1]); // delete photo-1.jpg (second card)

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        'http://pi.local:8000/media/photo-1.jpg',
        expect.objectContaining({
          method: 'DELETE',
          headers: { Authorization: 'Bearer secret' },
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByText('photo-1.jpg')).not.toBeInTheDocument());
  });

  it('shows an empty state when the drone reports no media', async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ media: [] }) }),
    );
    renderPage();
    expect(await screen.findByText(/no photos or recordings yet/i)).toBeInTheDocument();
  });

  it('shows an error state when the media store is unreachable', async () => {
    global.fetch = vi.fn(() => Promise.reject(new Error('network')));
    renderPage();
    expect(await screen.findByText(/couldn't reach the drone's media store/i)).toBeInTheDocument();
  });
});

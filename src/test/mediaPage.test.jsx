import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MediaPage from '../pages/MediaPage';

// MediaPage reads two stores: the Pi's media HTTP server (fetch) and Supabase
// (../lib/mediaStore). Mock useDrone (which also satisfies TopBar + Toasts),
// global.fetch, and the cloud module.
let mockCtx;
let cloudItems;      // what subscribeMedia hands back
let cloudDeletes;    // items passed to deleteMedia

vi.mock('../context/DroneContext', () => ({ useDrone: () => mockCtx }));
vi.mock('../lib/mediaStore', () => ({
  mediaCloudEnabled: true,
  subscribeMedia: (droneId, cb) => {
    cb(cloudItems);
    return () => {};
  },
  // Batched: MediaPage signs the whole grid in one call rather than one
  // request per capture.
  mediaUrls: (paths) =>
    Promise.resolve(
      Object.fromEntries(paths.map((p) => [p, `https://storage.test/${p}`])),
    ),
  deleteMedia: (item) => {
    cloudDeletes.push(item);
    return Promise.resolve();
  },
}));

const CLOUD = [
  {
    id: 'seagrass__photo-2.jpg',
    name: 'photo-2.jpg',
    type: 'photo',
    size: 4096,
    mtime: 1700000200,
    storagePath: 'drones/seagrass/photo-2.jpg',
    trigger: 'auto',
    context: { label: 'fish', confidence: 0.82, depth_m: 4.2, heading_deg: 137 },
    cloud: true,
  },
];

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
  cloudItems = [];
  cloudDeletes = [];
  mockCtx = {
    mediaBase: 'http://pi.local:8000',
    activeDrone: { name: 'Seagrass One', token: 'secret', camera_url: 'http://pi.local:8000/stream.mjpg' },
    // What DroneContext resolves to: the operator's Supabase session token when
    // signed in, the drone's own token in local mode. The page must not reach
    // past this to activeDrone.token — that is the long-lived secret the JWT
    // work exists to keep out of the browser's hands.
    operatorCredential: 'secret',
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

/** The card for a named capture. Grid order is newest-first, so addressing
 *  cards by index makes tests fail on unrelated fixture changes. */
function card(name) {
  return screen.getByText(name).closest('.media-card');
}

describe('MediaPage', () => {
  it('presents the operator session token, not the drone secret', async () => {
    // The whole point of the JWT work: a signed-in browser stops sending the
    // vehicle's long-lived credential. If this page reached for
    // activeDrone.token again, that secret would be back in the URL bar and in
    // every request, and nothing else would look wrong.
    mockCtx.operatorCredential = 'header.payload.signature';
    mockCtx.activeDrone = { ...mockCtx.activeDrone, token: 'long-lived-drone-secret' };
    renderPage();

    await screen.findByText('rec-1.mp4');
    const dl = within(card('rec-1.mp4')).getByText(/download/i).closest('a');
    expect(dl.getAttribute('href')).toContain('token=header.payload.signature');
    expect(dl.getAttribute('href')).not.toContain('long-lived-drone-secret');

    const listing = global.fetch.mock.calls.find(([url]) => url.endsWith('/media'));
    expect(listing[1].headers.Authorization).toBe('Bearer header.payload.signature');
  });

  it('falls back to the drone token in local mode, which has no session', async () => {
    // Local mode has no Supabase session at all, so DroneContext resolves the
    // credential to the drone's own token. That path has to keep working.
    mockCtx.operatorCredential = 'drone-token-only';
    renderPage();

    await screen.findByText('rec-1.mp4');
    const dl = within(card('rec-1.mp4')).getByText(/download/i).closest('a');
    expect(dl.getAttribute('href')).toContain('token=drone-token-only');
  });

  it('lists media from the drone with download links', async () => {
    renderPage();
    expect(await screen.findByText('rec-1.mp4')).toBeInTheDocument();
    expect(screen.getByText('photo-1.jpg')).toBeInTheDocument();
    // The token rides in the query string: this href, and the <img>/<video>
    // srcs beside it, are fetched by the browser itself, which cannot be given
    // an Authorization header. media_server.py now rejects these unauthenticated.
    const dl = within(card('rec-1.mp4')).getByText(/download/i).closest('a');
    expect(dl).toHaveAttribute(
      'href',
      'http://pi.local:8000/media/rec-1.mp4?token=secret',
    );
  });

  it('sorts newest first', async () => {
    renderPage();
    await screen.findByText('photo-1.jpg');
    const names = screen.getAllByText(/^(rec|photo)-/).map((el) => el.textContent);
    // photo-1.jpg has the later mtime, whatever order the drone listed them in.
    expect(names).toEqual(['photo-1.jpg', 'rec-1.mp4']);
  });

  it('deletes an item via authenticated DELETE and drops it from the grid', async () => {
    renderPage();
    await screen.findByText('photo-1.jpg');
    fireEvent.click(within(card('photo-1.jpg')).getByText(/delete/i));

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

  // The whole point of uploading: a capture taken on an unattended dive is
  // reviewable after the drone is switched off and put away.
  it('lists uploaded media with the drone powered off', async () => {
    cloudItems = CLOUD;
    global.fetch = vi.fn(() => Promise.reject(new Error('network')));
    renderPage();

    expect(await screen.findByText('photo-2.jpg')).toBeInTheDocument();
    // An unreachable drone is not an error when there is cloud media to show.
    expect(screen.queryByText(/couldn't reach the drone's media store/i)).not.toBeInTheDocument();
  });

  it('plays cloud media from Storage rather than the drone', async () => {
    cloudItems = CLOUD;
    renderPage();
    await screen.findByText('photo-2.jpg');
    await waitFor(() => {
      const img = screen.getByAltText('photo-2.jpg');
      expect(img).toHaveAttribute('src', 'https://storage.test/drones/seagrass/photo-2.jpg');
    });
  });

  it('shows why an autonomous capture happened', async () => {
    cloudItems = CLOUD;
    renderPage();
    // Detector label, confidence, depth and bearing — the difference between
    // "a photo" and "what the drone thought was worth photographing".
    expect(await screen.findByText(/fish 82%.*4\.2 m down.*bearing 137/)).toBeInTheDocument();
  });

  it('shows a capture present in both stores exactly once', async () => {
    cloudItems = [{ ...CLOUD[0], name: 'photo-1.jpg' }];
    renderPage();
    await screen.findByText('rec-1.mp4');
    await waitFor(() => expect(screen.getAllByText('photo-1.jpg')).toHaveLength(1));
    // Backed up, and still on the card.
    expect(screen.getByText(/backed up/i)).toBeInTheDocument();
    expect(screen.getAllByText(/on drone only/i)).toHaveLength(1); // rec-1.mp4
  });

  it('deletes both copies so a capture cannot come back', async () => {
    cloudItems = [{ ...CLOUD[0], name: 'photo-1.jpg' }];
    renderPage();
    await screen.findByText('photo-1.jpg');

    fireEvent.click(within(card('photo-1.jpg')).getByText(/delete/i));

    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        'http://pi.local:8000/media/photo-1.jpg',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    await waitFor(() => expect(cloudDeletes).toHaveLength(1));
    expect(cloudDeletes[0].name).toBe('photo-1.jpg');
  });
});

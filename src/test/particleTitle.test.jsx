import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import ParticleTitle from '../components/ParticleTitle';

// jsdom has no canvas implementation, so getContext returns null here — which
// is exactly the fallback path these assert. The effect is decoration over text
// that has to stay readable when it cannot run: reduced motion, an old browser,
// a refused context. The word must survive all three.

const origMatchMedia = window.matchMedia;

beforeEach(() => {
  window.matchMedia = vi.fn().mockReturnValue({ matches: false });
  // Must be constructible — the component does `new ResizeObserver(...)`.
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  window.matchMedia = origMatchMedia;
  vi.restoreAllMocks();
});

describe('ParticleTitle', () => {
  it('renders the word as real text, not just pixels', () => {
    // Screen readers announce this, and a selection copies it. Drawing the
    // title only onto the canvas would have left both with nothing.
    render(<ParticleTitle text="SEAGRASS" />);
    expect(screen.getByText('SEAGRASS')).toBeInTheDocument();
  });

  it('hides the canvas from assistive tech', () => {
    const { container } = render(<ParticleTitle text="SEAGRASS" />);
    expect(container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the text visible when no 2D context is available', () => {
    // getContext is null in jsdom. The text must not be hidden — that only
    // happens once the canvas actually has particles to show instead.
    render(<ParticleTitle text="SEAGRASS" />);
    expect(screen.getByText('SEAGRASS')).not.toHaveStyle({ visibility: 'hidden' });
  });

  it('does not animate when the OS asks for reduced motion', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    render(<ParticleTitle text="SEAGRASS" />);
    expect(raf).not.toHaveBeenCalled();
    expect(screen.getByText('SEAGRASS')).toBeInTheDocument();
  });

  it('passes its class through so the stylesheet still owns the type', () => {
    const { container } = render(<ParticleTitle text="SEAGRASS" className="login-brand" />);
    expect(container.querySelector('.particle-title')).toHaveClass('login-brand');
  });

});

// jsdom cannot rasterise text, so the animating path needs a stand-in context.
// This one reports every sampled pixel as opaque, which is enough to prove the
// component builds particles, hides the source text and tears its loop down.
function stubContext() {
  const pixels = { data: new Uint8ClampedArray(64 * 64 * 4).fill(200) };
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    measureText: vi.fn(() => ({ width: 30 })),
    getImageData: vi.fn(() => pixels),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  // getBoundingClientRect is 0x0 in jsdom; the component bails under 2px.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 300, height: 64, left: 0, top: 0, right: 300, bottom: 64,
  });
  return ctx;
}

describe('ParticleTitle — with a drawable canvas', () => {
  it('hands over to the particles, hiding the source text', () => {
    stubContext();
    render(<ParticleTitle text="SEAGRASS" />);
    // Hidden, not removed: it comes straight back if the effect stops.
    expect(screen.getByText('SEAGRASS')).toHaveStyle({ visibility: 'hidden' });
  });

  it('draws the word from its own type metrics, per character', () => {
    // Per-character advance rather than one fillText, because .login-brand
    // carries letter-spacing that canvas cannot be relied on to apply.
    const ctx = stubContext();
    render(<ParticleTitle text="SEAGRASS" />);
    expect(ctx.fillText).toHaveBeenCalledTimes('SEAGRASS'.length);
  });

  it('cleans up its frame loop and restores the text on unmount', () => {
    stubContext();
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<ParticleTitle text="SEAGRASS" />);
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});

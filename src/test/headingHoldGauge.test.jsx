import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HeadingHoldGauge } from '../components/Instruments';

// A render fault here takes the whole Control page down with it — the gauge sits
// inside the instrument cluster with no error boundary between it and the app,
// so a bad export or a null-handling slip would look like "the UI won't connect"
// rather than like a broken gauge.
describe('HeadingHoldGauge', () => {
  it('renders with everything null and does not throw', () => {
    render(<HeadingHoldGauge />);
    expect(screen.getByText('OFF')).toBeTruthy();
    expect(screen.getByRole('button').textContent).toBe('Hold this heading');
  });

  it('shows HOLD when engaged and steering', () => {
    render(
      <HeadingHoldGauge engaged suspended={false} setpoint={92} heading={88.4}
                        error={3.6} output={0.108} ok armed />,
    );
    expect(screen.getByText('HOLD')).toBeTruthy();
    expect(screen.getByRole('button').textContent).toBe('Release');
  });

  // The state that matters most: still engaged, but the pilot has the stick.
  it('shows MANUAL when engaged but suspended', () => {
    render(
      <HeadingHoldGauge engaged suspended setpoint={92} heading={70.1}
                        error={21.9} output={0} ok={false} armed />,
    );
    expect(screen.getByText('MANUAL')).toBeTruthy();
  });

  it('disables engaging while disarmed, and enables it once armed', () => {
    const { unmount } = render(<HeadingHoldGauge armed={false} />);
    expect(screen.getByRole('button').disabled).toBe(true);
    unmount();
    render(<HeadingHoldGauge armed />);
    expect(screen.getByRole('button').disabled).toBe(false);
  });

  it('calls engage when off and release when on', () => {
    const onEngage = vi.fn();
    const onRelease = vi.fn();
    const { unmount } = render(
      <HeadingHoldGauge armed onEngage={onEngage} onRelease={onRelease} />,
    );
    fireEvent.click(screen.getByRole('button'));
    expect(onEngage).toHaveBeenCalledTimes(1);
    expect(onRelease).not.toHaveBeenCalled();
    unmount();

    render(<HeadingHoldGauge engaged armed onEngage={onEngage} onRelease={onRelease} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});

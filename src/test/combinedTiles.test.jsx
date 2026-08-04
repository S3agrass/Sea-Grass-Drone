import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Vitals, Autopilot } from '../components/Instruments';

// The strip is one row, so its height is its TALLEST tile. Merging two tiles by
// stacking their contents would make that tile taller and push the map, camera
// and sonar down — the opposite of the point. These merge sideways, so the
// combined tile is no taller than either half was.

describe('Vitals', () => {
  it('carries all five readings that were spread over two tiles', () => {
    render(
      <Vitals depth={2.4} altitude={0.31} climb={-0.4} speed={1.6} battery={82} />,
    );
    for (const label of ['DEPTH', 'ALT', 'CLIMB', 'SPD', 'BATT']) {
      expect(screen.getByText(label, { exact: false })).toBeInTheDocument();
    }
  });

  it('keeps saying that altitude is barometric', () => {
    // Alt and depth look interchangeable side by side and are not: alt is air
    // pressure and drifts, depth is the one to fly by. The old tile said so in
    // a footnote; the label carries it now.
    render(<Vitals depth={2.4} altitude={0.31} />);
    expect(screen.getByText(/baro/i)).toBeInTheDocument();
  });

  it('lays its halves out side by side, not stacked', () => {
    const { container } = render(<Vitals depth={1} speed={1} />);
    expect(container.querySelector('.inst-split')).toBeInTheDocument();
  });

  it('shows a dash rather than a zero for a reading it does not have', () => {
    render(<Vitals />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('Autopilot', () => {
  const hold = { engaged: false, setpoint: 90, heading: 87, error: -3, output: 0.2, ok: true };
  const pid = { setpoint: 1.5, measurement: 1.4, error: 0.1, output: 0.05, ok: true };

  it('shows both controllers in one tile', () => {
    render(<Autopilot headingHold={hold} pid={pid} armed />);
    expect(screen.getByText('hdg')).toBeInTheDocument();
    expect(screen.getByText('alt')).toBeInTheDocument();
  });

  it('marks the alt half as monitor-only', () => {
    // drone_server.py wires no vertical control authority to this output. Shown
    // beside a half that genuinely steers, it must not read as an equal.
    render(<Autopilot headingHold={hold} pid={pid} armed />);
    expect(screen.getByText('MONITOR')).toBeInTheDocument();
  });

  it('reports the heading hold state', () => {
    render(<Autopilot headingHold={{ ...hold, engaged: true }} pid={pid} armed />);
    expect(screen.getByText('HOLD')).toBeInTheDocument();
  });

  it('will not let an unarmed vehicle engage', async () => {
    // The server refuses unless armed, so the button must not fire a command
    // that can only come back as a rejection.
    //
    // aria-disabled rather than the `disabled` attribute: a disabled button is
    // not focusable, which put the explanation ("arm the vehicle first") out of
    // reach of the keyboard and screen-reader users who most need it read out.
    // The refusal is enforced by the handler instead, so this checks both the
    // announced state and that pressing it really does nothing.
    const onEngage = vi.fn();
    const user = userEvent.setup();
    render(<Autopilot headingHold={hold} pid={pid} armed={false} onEngage={onEngage} />);

    const button = screen.getByRole('button', { name: /hold heading/i });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(onEngage).not.toHaveBeenCalled();
  });

  it('explains why engaging is blocked, reachably', () => {
    // The reason used to live only in a `title` on an unfocusable button.
    render(<Autopilot headingHold={hold} pid={pid} armed={false} />);
    const button = screen.getByRole('button', { name: /hold heading/i });
    expect(button).toHaveAccessibleDescription(/arm the vehicle/i);
  });

  it('engages and releases', async () => {
    const onEngage = vi.fn();
    const onRelease = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <Autopilot headingHold={hold} pid={pid} armed onEngage={onEngage} onRelease={onRelease} />,
    );
    await user.click(screen.getByRole('button', { name: /hold heading/i }));
    expect(onEngage).toHaveBeenCalled();

    rerender(
      <Autopilot
        headingHold={{ ...hold, engaged: true }}
        pid={pid}
        armed
        onEngage={onEngage}
        onRelease={onRelease}
      />,
    );
    await user.click(screen.getByRole('button', { name: /release/i }));
    expect(onRelease).toHaveBeenCalled();
  });
});

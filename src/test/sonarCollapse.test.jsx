import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SonarView from '../components/SonarView';

// The sonar strip is ~110px of the deck's height, and row 1 — the map and the
// camera — is the only row that can pay for it. Collapsing hands that back, and
// the choice is remembered: whichever way an operator wants this strip, they
// want it every session rather than once.

// SonarView takes its profiles off a direct link subscription rather than
// through context state, so the mock has to provide one.
vi.mock('../context/DroneContext', () => ({
  useDrone: () => ({
    link: { subscribe: () => () => {} },
    sonar: { distance_m: 2.4, raw_m: 2.5, confidence: 80, quality: 'good', ok: true, brake: 0, braking: false },
    telemetry: { heading: 42, depth: 1.2, roll: 0, pitch: 0, yaw: 42 },
    linkStatus: 'connected',
    demoMode: false,
  }),
}));

beforeEach(() => {
  localStorage.clear();
});

describe('sonar strip collapse', () => {
  it('starts expanded and folds away when asked', async () => {
    const user = userEvent.setup();
    const { container } = render(<SonarView />);

    expect(container.querySelector('.sonar-body')).not.toHaveAttribute('hidden');

    await user.click(screen.getByRole('button', { expanded: true }));

    expect(container.querySelector('.sonar-body')).toHaveAttribute('hidden');
  });

  it('remembers that it was collapsed', () => {
    localStorage.setItem('seagrass-sonar-collapsed', '1');
    const { container } = render(<SonarView />);

    expect(container.querySelector('.sonar-body')).toHaveAttribute('hidden');
  });

  it('persists the choice so the next session opens the same way', async () => {
    const user = userEvent.setup();
    render(<SonarView />);

    await user.click(screen.getByRole('button', { expanded: true }));

    expect(localStorage.getItem('seagrass-sonar-collapsed')).toBe('1');
  });
});

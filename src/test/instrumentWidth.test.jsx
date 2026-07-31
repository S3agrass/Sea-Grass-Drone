import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import {
  SonarGauge,
  AttitudeIndicator,
  HeadingHoldGauge,
  PIDGauge,
  AltitudeMeter,
  DepthMeter,
} from '../components/Instruments';

// The instrument strip lays tiles out in ~120px columns. Four of the gauges are
// horizontal by construction — an attitude ball beside its readout column, the
// PID/heading-hold four-column rows, sonar's paired bars — and need two of them.
//
// That span rule was lost once already: the deck rebuild landed with it stubbed
// out ("spans removed for measurement") while the comment describing it stayed,
// which is what pushed the Alt-Hold PID numbers outside their box. These pin
// both halves of it, since neither is any use without the other.

const css = readFileSync(resolve(process.cwd(), 'src/styles/app.css'), 'utf8');

function classesOf(ui) {
  const { container } = render(ui);
  return container.firstChild.className;
}

describe('instrument tile widths', () => {
  it('gives the horizontal gauges the wide class', () => {
    expect(classesOf(<PIDGauge setpoint={12} measurement={11.5} error={0.5} output={0.15} ok />)).toContain('inst-wide');
    expect(classesOf(<HeadingHoldGauge setpoint={90} heading={88} error={2} output={0.1} ok />)).toContain('inst-wide');
    expect(classesOf(<AttitudeIndicator roll={4} pitch={-2} yaw={90} />)).toContain('inst-wide');
    expect(classesOf(<SonarGauge distance={2.4} confidence={80} quality="good" ok />)).toContain('inst-wide');
  });

  it('leaves the single-value gauges narrow', () => {
    expect(classesOf(<AltitudeMeter altitude={12.3} />)).not.toContain('inst-wide');
    expect(classesOf(<DepthMeter depth={1.2} />)).not.toContain('inst-wide');
  });

  it('defines the span the wide class asks for', () => {
    expect(css).toMatch(/\.inst-wide\s*\{[^}]*grid-column:\s*span 2/);
  });

  it('lets the PID number columns shrink instead of overflowing the tile', () => {
    // A bare `1fr` will not go below its content width, which is precisely how
    // the readings ended up drawn outside the tile border.
    const rule = css.match(/\.pid-row\s*\{[^}]*\}/)[0];
    expect(rule).toContain('minmax(0, 1fr)');
  });
});

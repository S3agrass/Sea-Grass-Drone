import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Resizer from '../components/Resizer';

// The deck's proportions come from CSS custom properties so they can be changed
// without a rebuild. These hand the same values to the operator: what a drag
// writes is exactly what a developer would have typed into theme.css.

function setup(props = {}) {
  const onChange = vi.fn();
  const onReset = vi.fn();
  render(
    <Resizer
      orientation="vertical"
      value={400}
      min={300}
      max={900}
      measure={() => 420}
      onChange={onChange}
      onReset={onReset}
      label="Rail width"
      {...props}
    />,
  );
  return { onChange, onReset, handle: screen.getByRole('separator') };
}

beforeEach(() => {
  // jsdom implements neither, and the component must not depend on them.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

describe('Resizer', () => {
  it('is a labelled separator, so it is reachable without a mouse', () => {
    const { handle } = setup();
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAccessibleName('Rail width');
    expect(handle).toHaveAttribute('tabindex', '0');
  });

  it('grows the panel when dragged towards it', () => {
    // The handle is on the panel's leading edge, so dragging left widens it.
    const { onChange, handle } = setup();
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 460, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(440);
  });

  it('shrinks it when dragged away', () => {
    const { onChange, handle } = setup();
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 560, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(340);
  });

  it('refuses to drag a panel past its limits', () => {
    // The rail has to fit a keypad and a 16:9 feed whatever the window does.
    const { onChange, handle } = setup();
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 1500, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(300);

    fireEvent.pointerMove(handle, { clientX: -1500, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(900);
  });

  it('ignores movement when nothing is being dragged', () => {
    const { onChange, handle } = setup();
    fireEvent.pointerMove(handle, { clientX: 100, pointerId: 1 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picks up from the rendered size on the first drag', () => {
    // Until it is dragged the panel is whatever the stylesheet made it, and
    // `value` is null. Starting from a hardcoded default would jump the layout.
    const { onChange, handle } = setup({ value: null });
    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 490, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(430); // 420 measured + 10
  });

  it('resizes from the keyboard', () => {
    const { onChange, handle } = setup();
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(408);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(392);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(432);
  });

  it('hands the panel back to the stylesheet on double-click or Home', async () => {
    const user = userEvent.setup();
    const { onReset, handle } = setup();
    await user.dblClick(handle);
    expect(onReset).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('uses the vertical axis when horizontal', () => {
    // Own limits: the strip's floor is far below the rail's.
    const { onChange, handle } = setup({ orientation: 'horizontal', value: 150, min: 64, max: 520 });
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal');
    fireEvent.pointerDown(handle, { clientY: 600, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 570, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith(180); // dragged up, strip taller
  });
});

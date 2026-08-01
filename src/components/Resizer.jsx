import { useCallback, useRef } from "react";

// A drag handle that resizes a deck panel.
//
// The deck's proportions already come from CSS custom properties, on :root, so
// that they can be changed live without a rebuild — see the layout block in
// theme.css. This is the same idea handed to the operator: drag, and the value
// written is exactly the one a developer would have typed.
//
// It reports a NUMBER OF PIXELS, not a ratio. A ratio sounds tidier but behaves
// worse here: the rail has to fit a keypad and a 16:9 feed whatever the window
// is doing, and a proportional rail on a small laptop lands below both.
//
// Keyboard as well as pointer, because a splitter that can only be dragged is
// unusable to anyone driving this from a keyboard — and this is a vehicle
// control station, where that is not a hypothetical.
export default function Resizer({
  orientation,        // "vertical" = a column divider (drag left/right)
  value,              // current size in px, or null while the CSS default applies
  min,
  max,
  measure,            // () => current rendered size, for the first drag off `null`
  onChange,
  onReset,
  label,
}) {
  const drag = useRef(null);
  const isVertical = orientation === "vertical";

  const clamp = useCallback((v) => Math.max(min, Math.min(max, v)), [min, max]);

  const onPointerDown = (e) => {
    // Until the first drag, `value` is null and the panel is whatever the
    // stylesheet made it. Measure the rendered size so the handle picks up from
    // where the panel actually is rather than jumping to a default.
    const start = value ?? measure();
    drag.current = { pos: isVertical ? e.clientX : e.clientY, start };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!drag.current) return;
    const now = isVertical ? e.clientX : e.clientY;
    // Both handles sit on the leading edge of the panel they size, so dragging
    // towards the panel's own side makes it smaller: the delta is subtracted.
    onChange(clamp(drag.current.start - (now - drag.current.pos)));
  };

  const onPointerUp = (e) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const onKeyDown = (e) => {
    const step = e.shiftKey ? 32 : 8;
    const grow = isVertical ? "ArrowLeft" : "ArrowUp";
    const shrink = isVertical ? "ArrowRight" : "ArrowDown";
    if (e.key === grow || e.key === shrink) {
      e.preventDefault();
      const base = value ?? measure();
      onChange(clamp(base + (e.key === grow ? step : -step)));
    } else if (e.key === "Home" || e.key === "Escape") {
      e.preventDefault();
      onReset();
    }
  };

  return (
    <div
      className={`resizer resizer-${orientation}`}
      role="separator"
      aria-orientation={isVertical ? "vertical" : "horizontal"}
      aria-label={label}
      aria-valuenow={value ?? undefined}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
      title={`${label} — drag, or arrow keys. Double-click to reset.`}
    >
      <span className="resizer-grip" />
    </div>
  );
}

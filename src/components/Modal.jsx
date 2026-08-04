import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Everything that can hold focus. Order matters: querySelectorAll returns
// document order, which is the order Tab actually visits.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * A real modal dialog.
 *
 * The three overlays in this app were each a plain `<div>` with an onClick:
 * visually on top, but to a keyboard or a screen reader they did not exist as
 * dialogs at all. Tab walked straight out of the drone editor into the fleet
 * behind it, Escape did nothing, and on close focus landed back at the top of
 * the document instead of on the button that had opened the thing. That is a
 * keyboard trap in the WCAG 2.1.2 sense once the background is also scrollable,
 * and it is the single worst navigation failure in the product — so it is fixed
 * once, here, rather than three times slightly differently.
 *
 * What this guarantees:
 *   - role="dialog" + aria-modal, named by `labelledBy` (preferred) or `label`
 *   - focus moves in on open and is restored to the opener on close
 *   - Tab and Shift+Tab cycle within the dialog
 *   - Escape closes
 *   - the rest of the app is `inert` while it is open, so assistive tech does
 *     not wander into the background content underneath
 *
 * Rendered through a portal to <body> so the dialog is a sibling of #root
 * rather than a descendant — that is what lets #root be marked inert without
 * the dialog inerting itself along with it.
 */
export default function Modal({
  onClose,
  labelledBy,
  label,
  className = "modal",
  backdropClassName = "modal-backdrop",
  children,
}) {
  const dialogRef = useRef(null);
  // Captured during the mount effect rather than on first render, so it is the
  // element that had focus when the dialog opened, not whatever React was
  // touching mid-render.
  const openerRef = useRef(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    const node = dialogRef.current;
    const root = document.getElementById("root");

    // Move focus in. Prefer the first control; fall back to the dialog itself
    // (tabIndex -1) when it has none, so focus is never left behind in the
    // background where Tab would resume from the wrong place.
    const first = node?.querySelector(FOCUSABLE);
    (first || node)?.focus();

    if (root) root.inert = true;

    return () => {
      if (root) root.inert = false;
      const opener = openerRef.current;
      // The opener can legitimately be gone — deleting a drone unmounts the
      // card whose Edit button opened the editor. Only restore if it survived.
      if (opener && document.contains(opener) && typeof opener.focus === "function") {
        opener.focus();
      }
    };
  }, []);

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape") {
        // Stop here rather than letting it bubble to any page-level Escape
        // handler — closing the dialog is the only thing Escape should do while
        // the dialog is up.
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const node = dialogRef.current;
      if (!node) return;
      const items = Array.from(node.querySelectorAll(FOCUSABLE));
      if (items.length === 0) {
        // Nothing to move to; keep focus on the dialog rather than letting Tab
        // escape into the inert background.
        event.preventDefault();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && (active === first || active === node)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return createPortal(
    // The backdrop keeps click-to-dismiss for mouse users, but it is not the
    // only way out (Escape and an explicit Cancel/Close both exist), so it does
    // not need to be a control itself — and it must not be announced, or a
    // screen reader would read the dialog's own contents twice.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions, jsx-a11y/no-noninteractive-element-interactions
    <div
      className={backdropClassName}
      // Only a click on the backdrop itself dismisses. Comparing target to
      // currentTarget rather than hanging a stopPropagation handler on the
      // dialog: a click inside simply is not a click on this element, so the
      // dialog needs no mouse listener of its own.
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      {/* The keydown listener belongs on the dialog container: Escape and the
          Tab cycle have to be caught wherever focus is inside it, which is what
          the ARIA authoring practices prescribe for a modal. The lint rule only
          knows that "dialog" is not a widget role. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        className={className}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-label={labelledBy ? undefined : label}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

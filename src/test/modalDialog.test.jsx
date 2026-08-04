import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Modal from '../components/Modal';

// The three overlays in this app — the drone editor, the media lightbox, the
// fullscreen camera — were each a plain <div> with an onClick. Visually on top,
// but to a keyboard they did not exist as dialogs: Tab walked straight out into
// the page behind, Escape did nothing, and on close focus landed at the top of
// the document instead of on the control that had opened it. These tests pin
// the behaviour that replaced that, because it is invisible on screen and so
// nothing else would notice if it regressed.

function Harness({ onClose = () => {}, ...props }) {
  return (
    <Modal onClose={onClose} label="Test dialog" {...props}>
      <button>first</button>
      <button>second</button>
      <button>last</button>
    </Modal>
  );
}

describe('Modal — dialog semantics', () => {
  it('exposes itself as a modal dialog with a name', () => {
    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: 'Test dialog' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('prefers aria-labelledby when a heading id is given', () => {
    render(
      <Modal onClose={() => {}} labelledBy="t">
        <h2 id="t">Register drone</h2>
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Register drone' })).toBeInTheDocument();
  });

  it('moves focus into the dialog on open', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Harness onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('restores focus to whatever opened it', async () => {
    const user = userEvent.setup();

    function App() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Edit drone</button>
          {open && <Harness onClose={() => setOpen(false)} />}
        </>
      );
    }

    render(<App />);
    const opener = screen.getByRole('button', { name: 'Edit drone' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
  });

  it('cycles Tab within the dialog instead of escaping to the page behind', async () => {
    const user = userEvent.setup();
    render(
      <>
        <button>outside</button>
        <Harness />
      </>,
    );

    // Forward off the last control wraps to the first, rather than reaching
    // "outside" — the keyboard trap this component exists to prevent.
    screen.getByRole('button', { name: 'last' }).focus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();

    // And backwards off the first wraps to the last.
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('marks the rest of the app inert while open, and releases it on close', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);

    const { unmount } = render(<Harness />);
    expect(root.inert).toBe(true);

    unmount();
    expect(root.inert).toBe(false);

    root.remove();
  });
});

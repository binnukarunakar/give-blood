// The sheet is the last thing between a requester and an irreversible outcome
// (a unit counted, a donor released, a request cancelled), so its dialog
// behaviour is tested rather than assumed.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmSheet } from './ConfirmSheet';

const TITLE = 'Cancel this request?';
const CONSEQUENCE = 'Donors stop being alerted.';

function renderSheet(props: Partial<Parameters<typeof ConfirmSheet>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmSheet
      title={TITLE}
      consequence={CONSEQUENCE}
      confirmLabel="Yes, cancel"
      cancelLabel="Keep it"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

/**
 * A page with the opener the sheet replaces, and a second destructive control
 * behind it — the exact shape of request detail, where tabbing out of the sheet
 * used to land on "Cancel this request".
 */
function Host(): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Donated
      </button>
      {open ? (
        <ConfirmSheet
          title={TITLE}
          consequence={CONSEQUENCE}
          confirmLabel="Yes, cancel"
          cancelLabel="Keep it"
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      ) : null}
      <button type="button">Cancel this request</button>
    </>
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('ConfirmSheet', () => {
  it('is an alertdialog named by its question and described by its consequence', () => {
    renderSheet();

    const dialog = screen.getByRole('alertdialog', { name: TITLE });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleDescription(CONSEQUENCE);
  });

  it('moves focus to the question when it opens', () => {
    renderSheet();

    expect(screen.getByText(TITLE)).toHaveFocus();
  });

  it('cancels on Escape', async () => {
    const { onCancel, onConfirm } = renderSheet();

    await userEvent.setup().keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('ignores Escape while the confirm is in flight', async () => {
    const { onCancel } = renderSheet({ busy: true });

    await userEvent.setup().keyboard('{Escape}');

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('traps Tab inside the sheet, cycling between cancel and confirm', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Donated' }));

    const cancel = screen.getByRole('button', { name: 'Keep it' });
    const confirm = screen.getByRole('button', { name: 'Yes, cancel' });
    const behind = screen.getByRole('button', { name: 'Cancel this request' });

    // Focus opens on the title, which is not a Tab stop.
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    // The wrap: never out to the destructive control aria-modal calls inert.
    await user.tab();
    expect(cancel).toHaveFocus();
    expect(behind).not.toHaveFocus();
  });

  it('traps Shift-Tab the same way, backwards', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Donated' }));

    // Back from the title wraps to the last stop, not out to the opener.
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Yes, cancel' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Keep it' })).toHaveFocus();

    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Yes, cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Donated' })).not.toHaveFocus();
  });

  it('holds focus when every stop is disabled mid-confirm', async () => {
    renderSheet({ busy: true });
    const user = userEvent.setup();

    await user.tab();

    // Both buttons are disabled while the call is in flight; Tab must not walk
    // out of a dialog that has told assistive tech the page behind it is inert.
    expect(screen.getByRole('button', { name: 'Yes, cancel' })).toBeDisabled();
    expect(document.body).not.toHaveFocus();
  });

  it('returns focus to whatever opened it', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const opener = screen.getByRole('button', { name: 'Donated' });

    await user.click(opener);
    expect(screen.getByText(TITLE)).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Keep it' }));

    expect(opener).toHaveFocus();
  });

  it('stops trapping the keyboard once it is closed', async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole('button', { name: 'Donated' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    // The trap is torn down with the sheet: Tab reaches the page again.
    await user.tab();
    expect(screen.getByRole('button', { name: 'Cancel this request' })).toHaveFocus();
  });
});

// ConfirmSheet — the one confirmation pattern for any action that cannot be
// undone silently: a title, one line of consequence, a ghost cancel and one
// confirm (DESIGN.md § Donor home — "danger-quiet confirm pattern").
//
// Both roles use it. Donor: record a donation, revoke consent, withdraw a
// pledge — the confirm is the primary action. Requester: cancel a request —
// the confirm is destructive, so it takes the `danger` variant, which is a
// quiet bordered button and never a red slab.
//
// It is a dialog, so it behaves like one (GB-33): opening it moves focus to the
// question, Escape is the same answer as the cancel button, and closing it puts
// focus back where it came from. `alertdialog` rather than `dialog` because
// every use of it is a consequence being confirmed, not a form being filled.
//
// And it traps Tab (GB-33c). `aria-modal` tells a screen reader the rest of the
// page is inert; before the trap that was a lie, and the lie was expensive —
// tabbing out of "Confirm this donor arrived and donated?" landed on "Cancel
// this request", a destructive action assistive tech had been told was not
// there. Either the attribute goes or the behaviour matches it.
import { useEffect, useId, useRef, type ReactElement } from 'react';
import { Button } from './Button';

/** Tab stops inside the sheet. The title is tabIndex -1 and so excluded. */
const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), [tabindex="0"]';

export interface ConfirmSheetProps {
  /** The question, e.g. "Withdraw your pledge?". */
  title: string;
  /** What happens if they say yes. One sentence. */
  consequence: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` for destructive confirms; `primary` (default) for the rest. */
  confirmVariant?: 'primary' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmSheet({
  title,
  consequence,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmSheetProps): ReactElement {
  const titleId = useId();
  const noteId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLParagraphElement>(null);
  // Read through refs so the Escape listener is installed once per open rather
  // than re-installed on every render an inline arrow prop causes.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  const blocked = useRef(busy);
  blocked.current = busy;

  // The sheet is mounted only while it is open — every caller renders it
  // conditionally — so mount/unmount IS open/close: focus in on mount, focus
  // back to whatever opened it on unmount.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    titleRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        // Escape is the cancel button, and it is refused for the same reason
        // the cancel button is disabled: a call is already in flight.
        if (!blocked.current) cancel.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const sheet = sheetRef.current;
      if (sheet === null) return;
      const stops = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
      // Every stop disabled (both buttons are, mid-confirm): hold focus rather
      // than let Tab walk out into a page the dialog claims is inert.
      if (stops.length === 0) {
        event.preventDefault();
        return;
      }

      const first = stops[0];
      const last = stops[stops.length - 1];
      if (first === undefined || last === undefined) return;
      // -1 covers both the title (focused on open, never a Tab stop) and any
      // focus that has already escaped: forward lands on the first stop, back
      // on the last.
      const index = stops.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (index <= 0 ? last : stops[index - 1])
        : (index === -1 || index === stops.length - 1 ? first : stops[index + 1]);

      event.preventDefault();
      next?.focus();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      opener?.focus();
    };
  }, []);

  return (
    <div
      ref={sheetRef}
      className="confirm-sheet"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={noteId}
    >
      {/* tabIndex -1: focusable by script, never by Tab — the question is where
          a reader should start, not a stop on the way to the buttons. */}
      <p className="confirm-sheet-title" id={titleId} ref={titleRef} tabIndex={-1}>
        {title}
      </p>
      <p className="confirm-sheet-note" id={noteId}>
        {consequence}
      </p>
      <div className="confirm-sheet-actions">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} loading={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}

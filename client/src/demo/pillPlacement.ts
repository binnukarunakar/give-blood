// Where the floating demo chrome is allowed to sit.
//
// Split out of PushInbox.tsx at GB-33c to keep both files under the 300-line
// cap: this module owns the geometry, that one owns the panel.
import { useEffect, useRef, useState, type RefObject } from 'react';

/** Anything a tap at those coordinates could have been meant for. */
const INTERACTIVE = 'button, a, [role="switch"]';

/** How far the pill climbs looking for a clear spot, and in what steps. */
const LIFT_STEP_PX = 8;
const MAX_LIFT_RATIO = 0.4;

interface Span {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PillPlacement {
  /** Pixels the pill is translated up from where it normally sits. */
  lift: number;
  /** Inert and dimmed. Only when nothing within reach is clear. */
  ghost: boolean;
}

const HOME: PillPlacement = { lift: 0, ghost: false };

/** Every control the app owns that is currently laid out. Demo chrome excluded
 *  — the inbox is not an obstacle to itself. */
function controlSpans(): Span[] {
  const spans: Span[] = [];
  for (const node of document.querySelectorAll(INTERACTIVE)) {
    if (node.closest('.demo-inbox') !== null) continue;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    spans.push(rect);
  }
  return spans;
}

function clearAt(base: Span, controls: Span[], lift: number): boolean {
  const top = base.top - lift;
  const bottom = base.bottom - lift;
  return !controls.some(
    (other) =>
      base.left < other.right &&
      base.right > other.left &&
      top < other.bottom &&
      bottom > other.top,
  );
}

/**
 * Where the pill should sit.
 *
 * Move first, dim second (GB-33c). Ghosting alone answered "never steal a tap"
 * and broke the thing it was protecting: on donor home's landing scroll the
 * pill covers the snooze and consent rows, so it arrived already inert and the
 * inbox could not be opened at all without scrolling first. A pill that has
 * somewhere to go should go there and stay usable; dimming is what is left when
 * it does not.
 *
 * `appliedLift` undoes the translate already on the element, so every candidate
 * is measured from the pill's natural resting place and not from wherever it
 * last climbed to.
 */
function placePill(pill: HTMLElement, appliedLift: number): PillPlacement {
  const rect = pill.getBoundingClientRect();
  // A layout-less DOM (jsdom) measures everything at zero, which would read as
  // "everything overlaps everything". No layout, no overlap.
  if (rect.width === 0 || rect.height === 0) return HOME;

  const base: Span = {
    left: rect.left,
    right: rect.right,
    top: rect.top + appliedLift,
    bottom: rect.bottom + appliedLift,
  };
  const controls = controlSpans();
  const maxLift = window.innerHeight * MAX_LIFT_RATIO;

  for (let lift = 0; lift <= maxLift; lift += LIFT_STEP_PX) {
    if (clearAt(base, controls, lift)) return { lift, ghost: false };
  }
  // Nowhere to stand. Home and inert, so the tap lands on the control instead.
  return { lift: 0, ghost: true };
}

/**
 * Keeps the pill off the app's controls.
 *
 * Measured on scroll, on resize, and on any change to the DOM under it, at most
 * once per frame. The third trigger is not optional: donor home renders
 * skeletons first and grows its switch rows only when GET /donors/me answers,
 * so the control the pill ends up covering arrives with no scroll and no resize
 * to announce it. Only `childList` is watched, so the class and transform this
 * hook sets can never re-trigger it.
 *
 * `watch` re-runs the whole subscription when the pill appears, disappears, or
 * changes width (a badge count arriving).
 */
export function usePillPlacement(
  pill: RefObject<HTMLButtonElement | null>,
  watch: string,
): PillPlacement {
  const [placement, setPlacement] = useState<PillPlacement>(HOME);
  // Mirrors what the DOM is actually translated by. Written after commit, so a
  // measurement always subtracts the lift the element really carries.
  const appliedLift = useRef(0);

  useEffect(() => {
    appliedLift.current = placement.lift;
  }, [placement.lift]);

  useEffect(() => {
    const node = pill.current;
    if (node === null) {
      setPlacement(HOME);
      return undefined;
    }

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const next = placePill(node, appliedLift.current);
      setPlacement((current) =>
        current.lift === next.lift && current.ghost === next.ghost ? current : next,
      );
    };
    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const tree = new MutationObserver(schedule);
    tree.observe(document.body, { childList: true, subtree: true });

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      tree.disconnect();
    };
  }, [pill, watch]);

  return placement;
}

// StickyBar — the decision bar. Fixed to the bottom of the viewport with a
// blurred backdrop and the phone's safe-area inset honoured.
//
// The bar is rendered into document.body, not in place. `position: fixed`
// resolves against the nearest ancestor that establishes a containing block,
// and any animated transform up the tree does that: with the bar in place under
// Layout's `.route` wrapper it measured at y=438 in an 844px viewport instead of
// pinned to the bottom (GB-31a). A portal takes the bar out of every screen's
// subtree, so no page can move it by accident. `styles.css` also drops the
// transform from the route animation — the fix is deliberately both ends.
//
// It stays one React tree, so React events and context cross the portal
// untouched; the demo push inbox watches document.body for `.sticky-bar` and
// still sees it (DESIGN.md — demo chrome may never overlap the decision bar).
//
// One thing does not cross: form ownership is DOM ancestry. A `type="submit"`
// button in here belongs to no form unless it carries `form="<the form's id>"`
// (see donor/Onboarding.tsx).
import type { ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface StickyBarProps {
  /** Names the bar for screen readers, e.g. "Alert actions". */
  label: string;
  children: ReactNode;
}

export function StickyBar({ label, children }: StickyBarProps): ReactElement {
  return (
    <>
      {/* Reserves scroll room so the bar never covers the last line of content. */}
      <div className="sticky-bar-spacer" aria-hidden="true" />
      {createPortal(
        <div className="sticky-bar" role="group" aria-label={label}>
          <div className="sticky-bar-inner">{children}</div>
        </div>,
        document.body,
      )}
    </>
  );
}

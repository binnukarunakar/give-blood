// Banner — one line of actionable copy. No icon, no title, no dismiss.
import type { ReactElement, ReactNode } from 'react';

export type BannerTone = 'info' | 'warn' | 'error';

export interface BannerProps {
  tone?: BannerTone;
  /** Errors announce themselves; info does not. */
  role?: 'alert' | 'status';
  children: ReactNode;
}

export function Banner({ tone = 'info', role, children }: BannerProps): ReactElement {
  return (
    <p className={`banner banner-${tone}`} role={role ?? (tone === 'error' ? 'alert' : undefined)}>
      {children}
    </p>
  );
}

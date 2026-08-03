// Card. One surface step, one hairline border, never nested (DESIGN.md).
import type { ReactElement, ReactNode } from 'react';

export interface CardProps {
  /** Rendered as the small uppercase section title, not a content heading. */
  title?: string;
  /** Numbered onboarding sections read "01", "02" — kept out of the title text. */
  step?: string;
  children: ReactNode;
}

export function Card({ title, step, children }: CardProps): ReactElement {
  return (
    <section className="card">
      {title === undefined ? null : (
        <p className="card-title">
          {step === undefined ? null : <span className="card-step">{step}</span>}
          {title}
        </p>
      )}
      {children}
    </section>
  );
}

// EmptyState — one sentence that says what is missing, one action that fixes it.
import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  message: string;
  /** A single specific CTA, or nothing. Never two. */
  action?: ReactNode;
}

export function EmptyState({ message, action }: EmptyStateProps): ReactElement {
  return (
    <div className="empty-state">
      <p className="empty-state-message">{message}</p>
      {action === undefined ? null : <div className="empty-state-action">{action}</div>}
    </div>
  );
}

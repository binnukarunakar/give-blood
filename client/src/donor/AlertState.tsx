// The calm end states: closed, declined, withdrawn. Nothing is left to decide,
// so nothing on screen competes — one line of what happened, one line of what
// it means, and a ghost way back (DESIGN.md § Alert detail).
import type { ReactElement } from 'react';
import { Link } from 'react-router';

export interface AlertStateProps {
  title: string;
  note: string;
}

export function AlertState({ title, note }: AlertStateProps): ReactElement {
  return (
    <div className="alert-state">
      <p className="alert-state-title">{title}</p>
      <p className="alert-state-note">{note}</p>
      <Link className="btn btn-ghost" to="/donor">
        Back
      </Link>
    </div>
  );
}

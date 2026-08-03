// Field — label above control, always. A placeholder is never a label
// (DESIGN.md); helper text explains, error text replaces it.
import type { InputHTMLAttributes, ReactElement } from 'react';

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id'> {
  id: string;
  label: string;
  helper?: string;
  error?: string;
}

export function Field({ id, label, helper, error, ...rest }: FieldProps): ReactElement {
  const noteId = `${id}-note`;
  const note = error ?? helper;

  return (
    <div className={error === undefined ? 'field' : 'field field-invalid'}>
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        {...rest}
        id={id}
        className="field-input"
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={note === undefined ? undefined : noteId}
      />
      {note === undefined ? null : (
        <p className={error === undefined ? 'field-note' : 'field-note field-error'} id={noteId}>
          {note}
        </p>
      )}
    </div>
  );
}

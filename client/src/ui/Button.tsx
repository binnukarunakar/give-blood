// Button. Four variants, two sizes. Destructive is quiet (text + hairline
// border), never a red slab — DESIGN.md.
import type { ButtonHTMLAttributes, ReactElement, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Swaps the label for a spinner and keeps the button's width. */
  loading?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  loading = false,
  disabled = false,
  type = 'button',
  children,
  ...rest
}: ButtonProps): ReactElement {
  const classes = ['btn', `btn-${variant}`];
  if (size === 'lg') classes.push('btn-lg');
  if (fullWidth) classes.push('btn-full');
  if (loading) classes.push('is-loading');

  return (
    <button
      {...rest}
      type={type}
      className={classes.join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      <span className="btn-label">{children}</span>
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : null}
    </button>
  );
}

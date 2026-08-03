// The entire icon set. DESIGN.md: inline SVG only, no icon library, 16/20px,
// currentColor. Icons are decorative by default — the control carries the name.
import type { ReactElement } from 'react';

export interface IconProps {
  /** 16 inline, 20 in controls. The drop mark also runs at 18 (brand) and 32 (login). */
  size?: number;
}

function frame(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 20 20',
    'aria-hidden': true,
    focusable: false,
  } as const;
}

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** The brand mark. The only filled icon, and the only place red is a shape. */
export function DropMark({ size = 20 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} fill="currentColor">
      <path d="M10 1.75c0 0-6 6.13-6 10.02a6 6 0 0 0 12 0C16 7.88 10 1.75 10 1.75Z" />
    </svg>
  );
}

export function CheckIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} {...STROKE}>
      <path d="M4.5 10.5 8 14l7.5-8" />
    </svg>
  );
}

export function ChevronIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} {...STROKE}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}

export function CloseIcon({ size = 20 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} {...STROKE}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </svg>
  );
}

export function PhoneIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} {...STROKE}>
      <path d="M6.2 3.2 4 4.4c-.6 1.9 1 5.3 3 7.3s5.4 3.6 7.3 3l1.2-2.2-2.7-1.9-1.6 1.3c-.9-.4-1.9-1.1-2.6-1.8s-1.4-1.7-1.8-2.6l1.3-1.6-1.9-2.7Z" />
    </svg>
  );
}

export function PinIcon({ size = 16 }: IconProps): ReactElement {
  return (
    <svg {...frame(size)} {...STROKE}>
      <path d="M10 17.5s5.25-5.1 5.25-9a5.25 5.25 0 1 0-10.5 0c0 3.9 5.25 9 5.25 9Z" />
      <circle cx="10" cy="8.4" r="1.9" />
    </svg>
  );
}

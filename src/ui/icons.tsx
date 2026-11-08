/** Line icons drawn for this app, in currentColor at a 24 unit grid. */

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

/** A mold box open at the top, with a drop of silicone going in. */
export function Logo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3.5 10.5v8.5a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-8.5" />
      <path d="M7.5 20.5v-4.5a4.5 4.5 0 0 1 9 0v4.5" />
      <path d="M12 2.8c1.7 2.1 2.6 3.6 2.6 4.8a2.6 2.6 0 0 1-5.2 0c0-1.2.9-2.7 2.6-4.8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function Sun() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </svg>
  );
}

export function Moon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z" />
    </svg>
  );
}

/** Points right; rotated by CSS where it must point another way. */
export function Chevron() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke} stroke-width="2.6">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function Eye({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      {open ? <circle cx="12" cy="12" r="2.8" /> : <path d="M4 20L20 4" />}
    </svg>
  );
}

export function Pin() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 21.5v-6.5" />
      <path d="M8 3.5h8l-1.2 5.2 3.2 3.3v1.5H6v-1.5l3.2-3.3z" />
    </svg>
  );
}

export function Cross() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke} stroke-width="2.2">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** A file with an arrow into it, for the drop area. */
export function Inbox() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...stroke} stroke-width="2">
      <path d="M8 30v8a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3v-8" />
      <path d="M24 6v24M15 21l9 9 9-9" />
    </svg>
  );
}

/** A hooked arrow back to the left. Redo is its mirror image, drawn on its own. */
export function Undo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M9 14.5L4 9.5l5-5" />
      <path d="M4 9.5h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}

export function Redo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M15 14.5l5-5-5-5" />
      <path d="M20 9.5H9.5a5.5 5.5 0 0 0 0 11H13" />
    </svg>
  );
}

/** Looking down on a box from above: its outline with a ring on the top, for the top view. */
export function TopView() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

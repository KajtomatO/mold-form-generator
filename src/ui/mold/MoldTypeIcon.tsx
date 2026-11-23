/**
 * MT: each mold type's pictogram, a static line drawing in currentColor on the icons' 24 unit grid
 * (src/ui/icons.tsx), which the tiles and the collapsed sidebar's rail show. HB moves them to the help registry and
 * makes them pull apart on hover and focus (docs/PLAN.md, HB).
 */

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

/** The one-piece cover: a box over a model on its base plate, lifted straight up. */
function OnePiece() {
  return (
    <>
      <path d="M5 13.5V6.5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v7" />
      <path d="M12 2.2v2" />
      <path d="M10.6 3.4L12 2.2l1.4 1.2" />
      <path d="M3.5 19.5h17v-2.2h-17z" />
      <path d="M9 17.3v-2.8a3 3 0 0 1 6 0v2.8" />
    </>
  );
}

/** The two-part cover: the cover split down the middle, its halves sliding apart over the model and base. */
function Clamshell() {
  return (
    <>
      <path d="M10.2 13.5V6.5h-5a1 1 0 0 0-1 1v6" />
      <path d="M13.8 13.5V6.5h5a1 1 0 0 1 1 1v6" />
      <path d="M2.2 10h1.6M20.2 10h1.6" />
      <path d="M3 9l-1 1 1 1M21 9l1 1-1 1" />
      <path d="M3.5 19.5h17v-2.2h-17z" />
      <path d="M9 17.3v-2.8a3 3 0 0 1 6 0v2.8" />
    </>
  );
}

/** A type the drawings do not know yet, such as a test's fixture: the plain box. */
function Unknown() {
  return <rect x="5" y="6" width="14" height="13" rx="1.5" />;
}

export const MOLD_TYPE_ICONS: Readonly<Record<string, () => preact.JSX.Element>> = {
  'one-piece': OnePiece,
  clamshell: Clamshell,
};

export function MoldTypeIcon({ icon }: { icon: string }) {
  const Drawing = MOLD_TYPE_ICONS[icon] ?? Unknown;
  return (
    <svg class="mold-icon" viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <Drawing />
    </svg>
  );
}

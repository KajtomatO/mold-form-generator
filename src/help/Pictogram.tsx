import type { ComponentChildren } from 'preact';
import type { PictogramId } from './topics';

/**
 * HB: the help's line pictograms (R46), on the icons' 24 unit grid with their 1.8 stroke (src/ui/icons.tsx). The mold
 * types' are a section of the sphere in its mold: the silicone filled in the view's teal, the model and the printed
 * parts in currentColor. Each part that comes away is a `<g class="part">` with its own offset (--dx, --dy), which
 * the global stylesheet moves it by, in 250 ms, while the element round it marked `pull` is hovered or has the
 * keyboard's focus; with reduced motion the parts stay still and a thin outline (`ghost`) shows where each goes.
 * No WebGL, so the switch keeps its help where the view cannot draw.
 */

/** The silicone, as the view draws it (LAYER_COLOURS.silicone in src/view/materials.ts). */
export const SILICONE_FILL = '#2dd4bf';

const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' } as const;

/** A part that comes away by (dx, dy), drawn once in place and once as its outline where it goes. */
function Part({ dx = 0, dy = 0, draw }: { dx?: number; dy?: number; draw: () => ComponentChildren }) {
  const style = `--dx: ${dx}px; --dy: ${dy}px`;
  return (
    <>
      <g class="part" style={style}>
        {draw()}
      </g>
      <g class="ghost" style={style}>
        {draw()}
      </g>
    </>
  );
}

/** The sphere cut flat on its base face, standing on the plate's top at y = 18.6. */
const SPHERE = 'M9.4 18.6A3.8 3.8 0 1 1 14.6 18.6Z';

/** The silicone inside the cover, round the sphere: the cover's inside less the sphere, filled. */
function Silicone() {
  return <path d={`M5.4 5.9H18.6V18.6H5.4Z${SPHERE}`} fill={SILICONE_FILL} fill-rule="evenodd" stroke="none" />;
}

function Model() {
  return <path d={SPHERE} />;
}

/** The base plate under the mold, which comes away downwards. */
function Base() {
  return <Part dy={2.4} draw={() => <path d="M3.5 21h17v-2.4h-17z" />} />;
}

/** The one-piece cover: one box over the model, lifted straight up. */
function OnePiece() {
  return (
    <>
      <Silicone />
      <Model />
      <Part dy={-3.2} draw={() => <path d="M4.5 18.6V6a1 1 0 0 1 1-1h13a1 1 0 0 1 1 1v12.6" />} />
      <Base />
    </>
  );
}

/** The two-part cover: the box split down the middle, its halves sliding apart sideways. */
function Clamshell() {
  return (
    <>
      <Silicone />
      <Model />
      <Part dx={-2.6} draw={() => <path d="M11.1 18.6V5H5.5a1 1 0 0 0-1 1v12.6" />} />
      <Part dx={2.6} draw={() => <path d="M12.9 18.6V5h5.6a1 1 0 0 1 1 1v12.6" />} />
      <Base />
    </>
  );
}

/** The seam bolts: a lug on each half's end face, a countersunk screw through both, and its nut. */
function SeamBolts() {
  return (
    <>
      <Part dx={-1.4} draw={() => <path d="M5.5 8.5H12v7H5.5z" />} />
      <Part dx={1.4} draw={() => <path d="M12 8.5h6.5v7H12z" />} />
      <Part dx={-3.4} draw={() => <path d="M2.5 9.6v4.8L4.6 13v-2zM4.6 12h14.6" />} />
      <Part dx={3.4} draw={() => <path d="M19.4 9.9h1.9l1.1 2.1-1.1 2.1h-1.9z" />} />
    </>
  );
}

/** The seam clips: an ear on each half with half a dovetail socket, and the tapered key that fills both, slid out upwards. */
function SeamClips() {
  return (
    <>
      <Part dx={-1.4} draw={() => <path d="M12 12.5H4.5V20H12M12 14.4l-3.4-1.3v5.8l3.4-1.3" />} />
      <Part dx={1.4} draw={() => <path d="M12 12.5h7.5V20H12M12 14.4l3.4-1.3v5.8L12 17.6" />} />
      <Part dy={-8} draw={() => <path d="M8.6 13.1l3.4 1.3 3.4-1.3v5.8L12 17.6l-3.4 1.3z" />} />
    </>
  );
}

/** A drawing the pictograms do not know, such as a test's fixture type's: the plain box, which does not come apart. */
function Unknown() {
  return <rect x="5" y="6" width="14" height="13" rx="1.5" />;
}

export const PICTOGRAMS: Readonly<Record<PictogramId, () => preact.JSX.Element>> = {
  'one-piece': OnePiece,
  clamshell: Clamshell,
  'seam-bolts': SeamBolts,
  'seam-clips': SeamClips,
};

export function Pictogram({ id, class: className = 'pictogram' }: { id: string; class?: string }) {
  const Drawing = (PICTOGRAMS as Readonly<Record<string, () => preact.JSX.Element>>)[id] ?? Unknown;
  return (
    <svg class={className} data-pictogram={id} viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <Drawing />
    </svg>
  );
}

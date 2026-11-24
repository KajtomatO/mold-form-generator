import { Pictogram } from '../../help/Pictogram';

/**
 * MT: each mold type's pictogram, which the tiles and the collapsed sidebar's rail show. HB moved the drawings to the
 * help (src/help/Pictogram.tsx), where each part pulls apart while its tile or the rail is hovered or focused.
 */
export function MoldTypeIcon({ icon }: { icon: string }) {
  return <Pictogram id={icon} class="pictogram mold-icon" />;
}

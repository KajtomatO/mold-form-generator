import { Fragment } from 'preact';
import { useRef } from 'preact/hooks';
import { NOT_BUILT_YET } from '../../core/mold/types';
import { useStore } from '../context';
import { moldTypeTiles } from './moldTypeUi';
import { MoldTypeIcon } from './MoldTypeIcon';

/**
 * MT: the mold type switch (R44, D27), pinned at the top of the sidebar above Model and outside the scrolling
 * sections, as Export is pinned at its foot: a group of tile buttons, one per type, each its pictogram and name,
 * pressed for the type on screen. The tiles lie in a grid of `repeat(auto-fit, minmax(96px, 1fr))`, so more types
 * wrap with no change. Arrow keys move the focus along them and never switch; Enter or Space switches, as a click
 * does. A type that cannot be chosen for this model stays focusable, with a short tag, and why in full as its title and
 * its description, which a screen reader gives on focus, as a title is not shown then.
 */
export function MoldTypeSwitch() {
  const store = useStore();
  // The model's bodies and triangles, which a type's availability reads, come with the pipeline's changes.
  void store.tick.value;
  const current = store.moldType();
  const tiles = moldTypeTiles(store.moldTypes.value, store.moldTypeUi.value, store.typeContext());
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent): void => {
    const keys: Record<string, number> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };
    const buttons = [...(group.current?.querySelectorAll<HTMLButtonElement>('.mold-tile') ?? [])];
    const at = buttons.indexOf(event.currentTarget as HTMLButtonElement);
    let next: number | null = null;
    if (event.key in keys) next = (at + keys[event.key] + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    if (next === null) return;
    event.preventDefault();
    buttons[next].focus();
  };
  return (
    <section class="mold-type" data-section="moldType" aria-labelledby="mold-type-title">
      <h2 id="mold-type-title">Mold type</h2>
      <div class="mold-tiles" role="group" aria-labelledby="mold-type-title" ref={group}>
        {tiles.map((tile) => (
          <Fragment key={tile.id}>
            <button
              type="button"
              class="mold-tile"
              data-type={tile.id}
              aria-pressed={tile.id === current}
              aria-disabled={tile.unavailable ? 'true' : undefined}
              aria-describedby={tile.unavailable ? `mold-tile-reason-${tile.id}` : undefined}
              title={tile.unavailable ? `${tile.name}: ${tile.unavailable}.` : `${tile.name}: ${tile.blurb}`}
              onKeyDown={move}
              onClick={() => {
                if (!tile.unavailable) store.requestSwitch(tile.id);
              }}
            >
              <MoldTypeIcon icon={tile.icon} />
              <span class="name">{tile.name}</span>
              {tile.unavailable ? <span class="why">{tile.unavailable === NOT_BUILT_YET ? NOT_BUILT_YET : 'Not for this model'}</span> : null}
            </button>
            {/* Out of the button, so it is its description and not part of its name; absolute, so it takes no cell of the grid. */}
            {tile.unavailable ? (
              <span class="visually-hidden" id={`mold-tile-reason-${tile.id}`}>
                {`${tile.unavailable}.`}
              </span>
            ) : null}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

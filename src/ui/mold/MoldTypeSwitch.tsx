import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { NOT_BUILT_YET } from '../../core/mold/types';
import { savingText, savingTitle, typeSaving } from '../../app/derived';
import { preloadAnimation } from '../../help/HelpAnimation';
import { HelpButton } from '../../help/HelpButton';
import { HINT_DELAY_MS } from '../../help/config';
import { HelpHint } from '../../help/HelpHint';
import type { HelpTheme } from '../../help/media';
import { helpTopic } from '../../help/topics';
import { useStore } from '../context';
import { moldTypeTiles } from './moldTypeUi';
import { MoldTypeIcon } from './MoldTypeIcon';

/** HB: which tile's hint card shows, and the tile it stands beside. */
interface Hint {
  type: string;
  anchor: HTMLElement;
}

/**
 * HB: a tile's hint card, shown after HINT_DELAY_MS of hover or of focus from the keyboard, and gone on leave, blur,
 * a press or Esc. A focus from a click is not the keyboard's, so the card waits for the pointer's own delay then. While
 * a "?" popover is open it does not show, as it would lie over the popover and say again what the popover says.
 */
function useHint(theme: () => HelpTheme): { hint: Hint | null; handlers: (type: string, help: string) => preact.JSX.HTMLAttributes<HTMLButtonElement> } {
  const [hint, setHint] = useState<Hint | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hide = (): void => {
    clearTimeout(timer.current);
    setHint(null);
  };
  const later = (type: string, anchor: HTMLElement): void => {
    clearTimeout(timer.current);
    preloadAnimation(type, theme());
    timer.current = window.setTimeout(() => {
      if (!document.querySelector('.help-popover:popover-open')) setHint({ type, anchor });
    }, HINT_DELAY_MS);
  };
  useEffect(() => {
    if (!hint) return;
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [hint]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const handlers = (type: string, help: string): preact.JSX.HTMLAttributes<HTMLButtonElement> => {
    if (!helpTopic(help)) return {};
    return {
      onPointerEnter: (event) => later(type, event.currentTarget as HTMLElement),
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (event) => {
        const tile = event.currentTarget as HTMLElement;
        if (tile.matches(':focus-visible')) later(type, tile);
      },
      onBlur: hide,
    };
  };
  return { hint, handlers };
}

/**
 * MT: the mold type switch (R44, D27), pinned at the top of the sidebar above Model and outside the scrolling
 * sections, as Export is pinned at its foot: a group of tile buttons, one per type, each its pictogram and name,
 * pressed for the type on screen. The tiles lie in a grid of `repeat(auto-fit, minmax(96px, 1fr))`, so more types
 * wrap with no change. Arrow keys move the focus along them and never switch; Enter or Space switches, as a click
 * does. A type that cannot be chosen for this model stays focusable, with a short tag, and why in full as its title and
 * its description, which a screen reader gives on focus, as a title is not shown then. HB: each tile's pictogram pulls
 * apart on hover and focus, its hint card shows the type's explode animation, and the "?" in the heading opens the
 * help on every type (src/help/). A tile the card describes has no title, so the browser's own tooltip does not say its
 * line a second time beside the card; the card carries the Two-part tile's saving note instead.
 */
export function MoldTypeSwitch() {
  const store = useStore();
  // The model's bodies and triangles, which a type's availability reads, come with the pipeline's changes.
  void store.tick.value;
  const current = store.moldType();
  const tiles = moldTypeTiles(store.moldTypes.value, store.moldTypeUi.value, store.typeContext());
  // MP5: what the two-part cover saves on this model, from the reports job's estimate (G13.13).
  const estimate = typeSaving(store.pipeline);
  const saving = savingText(estimate), savingNote = savingTitle(estimate);
  const group = useRef<HTMLDivElement>(null);
  const { hint, handlers } = useHint(() => (store.theme.value === 'light' ? 'light' : 'dark'));
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
      <div class="mold-type-head">
        <h2 id="mold-type-title">Mold type</h2>
        <HelpButton id="mold.type" />
      </div>
      <div class="mold-tiles" role="group" aria-labelledby="mold-type-title" ref={group}>
        {tiles.map((tile) => {
          const hinted = hint?.type === tile.id ? `mold-tile-hint-${tile.id}` : null;
          const reason = tile.unavailable ? `mold-tile-reason-${tile.id}` : null;
          const topic = helpTopic(tile.help);
          const note = tile.id === 'clamshell' ? savingNote : null;
          return (
            <Fragment key={tile.id}>
              <button
                type="button"
                class="mold-tile pull"
                data-type={tile.id}
                data-help={topic ? tile.help : undefined}
                aria-pressed={tile.id === current}
                aria-disabled={tile.unavailable ? 'true' : undefined}
                aria-describedby={[hinted, reason].filter(Boolean).join(' ') || undefined}
                {...handlers(tile.id, tile.help)}
                title={tile.unavailable ? `${tile.name}: ${tile.unavailable}.` : topic ? undefined : `${tile.name}: ${tile.blurb}${note ? ` ${note}` : ''}`}
                onKeyDown={move}
                onClick={() => {
                  if (!tile.unavailable) store.requestSwitch(tile.id);
                }}
              >
                <MoldTypeIcon icon={tile.icon} />
                <span class="name">{tile.name}</span>
                {tile.unavailable ? <span class="why">{tile.unavailable === NOT_BUILT_YET ? NOT_BUILT_YET : 'Not for this model'}</span> : null}
                {/* Its line stands empty until the estimate is in, so the sidebar never shifts under the pointer when it comes. */}
                {!tile.unavailable && tile.id === 'clamshell' ? (
                  <span class="estimate" data-testid="two-part-estimate">
                    {saving ?? '\u00a0'}
                  </span>
                ) : null}
              </button>
              {/* Out of the button, so it is its description and not part of its name; absolute, so it takes no cell of the grid. */}
              {tile.unavailable ? (
                <span class="visually-hidden" id={`mold-tile-reason-${tile.id}`}>
                  {`${tile.unavailable}.`}
                </span>
              ) : null}
              {/* HB: the hint card, in the top layer while it shows, so it takes no cell of the grid either. */}
              {hinted && topic && hint ? <HelpHint id={hinted} topic={topic} note={note} anchor={hint.anchor} beside={group.current} /> : null}
            </Fragment>
          );
        })}
      </div>
    </section>
  );
}
